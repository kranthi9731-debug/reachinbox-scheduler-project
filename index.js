require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { createHash } = require("crypto");
const { Client } = require("@elastic/elasticsearch");
const { WebClient } = require("@slack/web-api");

const { emailQueue } = require("./queue");
const pool = require("./db");

const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");

const app = express();
const PORT = process.env.PORT || 3000;

// Elasticsearch connection
const elasticClient =
  process.env.ELASTICSEARCH_URL &&
  process.env.ELASTICSEARCH_API_KEY
    ? new Client({
        node: process.env.ELASTICSEARCH_URL,
        auth: {
          apiKey: process.env.ELASTICSEARCH_API_KEY,
        },
      })
    : null;

const EMAIL_INDEX = "reachinbox-emails";

// Slack connection
const slackClient = process.env.SLACK_BOT_TOKEN
  ? new WebClient(process.env.SLACK_BOT_TOKEN)
  : null;

// Slack notification helper
async function sendSlackNotification(text) {
  if (!slackClient || !process.env.SLACK_CHANNEL_ID) {
    console.log("Slack is not configured. Skipping notification.");
    return;
  }

  try {
    await slackClient.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID,
      text,
    });

    console.log("Slack notification sent.");
  } catch (error) {
    console.error(
      "Slack notification failed:",
      error.data?.error || error.message
    );
  }
}

// Google OAuth configuration
if (
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET &&
  process.env.GOOGLE_CALLBACK_URL
) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => {
        const user = {
          id: profile.id,
          name: profile.displayName,
          email: profile.emails?.[0]?.value || "",
          photo: profile.photos?.[0]?.value || "",
        };

        done(null, user);
      }
    )
  );

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));
}

// Bull Board setup
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter,
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      "reachinbox-local-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

app.use("/admin/queues", serverAdapter.getRouter());

// Elasticsearch indexing helper
async function indexEmail(email) {
  if (!elasticClient) {
    console.log(
      "Elasticsearch is not configured. Skipping indexing."
    );
    return;
  }

  try {
    await elasticClient.index({
      index: EMAIL_INDEX,
      id: email.id,
      refresh: "wait_for",
      document: {
        recipient: email.to,
        subject: email.subject,
        message: email.message,
        scheduledAt: email.scheduledAt,
        status: email.status,
        createdAt: new Date().toISOString(),
      },
    });

    console.log(
      "Email indexed in Elasticsearch:",
      email.id
    );
  } catch (error) {
    console.error(
      "Elasticsearch indexing failed:",
      error.message
    );
  }
}

// Home
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Google login
app.get("/auth/google", (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res
      .status(503)
      .send("Google OAuth is not configured.");
  }

  passport.authenticate("google", {
    scope: ["profile", "email"],
  })(req, res, next);
});

// Google callback
app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/?auth=failed",
  }),
  (req, res) => res.redirect("/")
);

// Current user
app.get("/api/me", (req, res) => {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.json({ loggedIn: false });
  }

  res.json({
    loggedIn: true,
    user: req.user,
  });
});

// Logout
app.get("/auth/logout", (req, res, next) => {
  req.logout((error) => {
    if (error) return next(error);

    req.session.destroy(() => res.redirect("/"));
  });
});

// General health check
app.get("/api/health", (req, res) => {
  res.json({
    message: "ReachInbox Scheduler API is running!",
  });
});

// Slack health check
app.get("/api/slack/health", async (req, res) => {
  if (!slackClient || !process.env.SLACK_CHANNEL_ID) {
    return res.status(503).json({
      connected: false,
      message:
        "Set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID in .env.",
    });
  }

  try {
    const result = await slackClient.auth.test();

    res.json({
      connected: true,
      team: result.team,
      bot: result.user,
      message: "Slack bot authentication successful.",
    });
  } catch (error) {
    res.status(500).json({
      connected: false,
      message: "Slack authentication failed.",
      error: error.data?.error || error.message,
    });
  }
});

// Slack test notification
app.post("/api/slack/test", async (req, res) => {
  if (!slackClient || !process.env.SLACK_CHANNEL_ID) {
    return res.status(503).json({
      message:
        "Set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID in .env.",
    });
  }

  try {
    await slackClient.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID,
      text:
        "✅ ReachInbox Scheduler Slack integration is working!",
    });

    res.json({
      message: "Test notification sent to Slack channel.",
    });
  } catch (error) {
    res.status(500).json({
      message: "Slack notification failed.",
      error: error.data?.error || error.message,
    });
  }
});

// Elasticsearch health check
app.get("/api/elasticsearch/health", async (req, res) => {
  if (!elasticClient) {
    return res.status(503).json({
      connected: false,
      message: "Elasticsearch credentials are missing.",
    });
  }

  try {
    const info = await elasticClient.info();

    res.json({
      connected: true,
      version: info.version?.number || "Available",
      message: "Elasticsearch connected successfully.",
    });
  } catch (error) {
    console.error(
      "Elasticsearch connection error:",
      error.message
    );

    res.status(500).json({
      connected: false,
      message: "Elasticsearch connection failed.",
    });
  }
});

// Schedule email
app.post("/api/schedule", async (req, res) => {
  try {
    const { to, subject, message, scheduledAt } = req.body;

    if (!to || !subject || !message || !scheduledAt) {
      return res.status(400).json({
        message: "Please fill in all fields.",
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({
        message: "Enter a valid recipient email.",
      });
    }

    const sendTime = new Date(scheduledAt);

    if (
      isNaN(sendTime.getTime()) ||
      sendTime <= new Date()
    ) {
      return res.status(400).json({
        message: "Choose a future date and time.",
      });
    }

    const scheduledTime = sendTime.toISOString();

    const uniqueData = JSON.stringify([
      to.trim().toLowerCase(),
      subject.trim(),
      message.trim(),
      scheduledTime,
    ]);

    const hash = createHash("sha256")
      .update(uniqueData)
      .digest("hex");

    const jobId = `email-${hash}`;

    const existingJob = await emailQueue.getJob(jobId);

    if (existingJob) {
      return res.status(200).json({
        message:
          "Duplicate email prevented. This email already exists.",
      });
    }

    const delay = sendTime.getTime() - Date.now();

    await pool.query(
      `INSERT INTO emails
       (job_id, recipient, subject, message, scheduled_at, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        jobId,
        to,
        subject,
        message,
        scheduledTime,
        "scheduled",
      ]
    );

    try {
      const job = await emailQueue.add(
        "send-email",
        {
          to,
          subject,
          message,
          scheduledAt: scheduledTime,
        },
        {
          jobId,
          delay,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        }
      );

      const email = {
        id: String(job.id),
        to,
        subject,
        message,
        scheduledAt: scheduledTime,
        status: "scheduled",
      };

      await indexEmail(email);

      // Send Slack notification
      await sendSlackNotification(
        `📧 *Email scheduled*\nTo: ${to}\nSubject: ${subject}\nScheduled: ${new Date(
          scheduledTime
        ).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        })}`
      );

      res.status(201).json({
        message: "Email scheduled successfully!",
        email,
      });
    } catch (queueError) {
      await pool.query(
        "UPDATE emails SET status = $1 WHERE job_id = $2",
        ["failed", jobId]
      );

      throw queueError;
    }
  } catch (error) {
    console.error("Scheduling failed:", error.message);

    res.status(500).json({
      message: "Could not schedule the email.",
    });
  }
});

// Get scheduled emails
app.get("/api/scheduled", async (req, res) => {
  try {
    const jobs = await emailQueue.getJobs([
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
    ]);

    const emails = await Promise.all(
      jobs.map(async (job) => {
        const state = await job.getState();

        return {
          id: String(job.id),
          ...job.data,
          status:
            state === "completed"
              ? "sent"
              : state === "failed"
              ? "failed"
              : state === "active"
              ? "sending"
              : "scheduled",
        };
      })
    );

    res.json(emails);
  } catch (error) {
    console.error(
      "Loading scheduled emails failed:",
      error.message
    );

    res.status(500).json({
      message: "Could not load emails from Redis.",
    });
  }
});

// Search emails using Elasticsearch
app.get("/api/search", async (req, res) => {
  if (!elasticClient) {
    return res.status(503).json({
      message: "Elasticsearch is not configured.",
    });
  }

  try {
    const query = String(req.query.q || "").trim();

    if (!query) {
      return res.status(400).json({
        message: "Enter a search term.",
      });
    }

    const indexExists = await elasticClient.indices.exists({
      index: EMAIL_INDEX,
    });

    if (!indexExists) {
      return res.json({
        total: 0,
        emails: [],
        message: "No emails indexed yet.",
      });
    }

    const result = await elasticClient.search({
      index: EMAIL_INDEX,
      query: {
        multi_match: {
          query,
          fields: ["subject", "recipient", "message"],
        },
      },
    });

    const emails = result.hits.hits.map((hit) => ({
      id: hit._id,
      ...hit._source,
    }));

    const total =
      typeof result.hits.total === "number"
        ? result.hits.total
        : result.hits.total.value;

    res.json({
      total,
      emails,
    });
  } catch (error) {
    console.error(
      "Elasticsearch search failed:",
      error
    );

    res.status(500).json({
      message: "Email search failed.",
      error: error.message,
    });
  }
});

// Sync PostgreSQL status with BullMQ
app.get("/api/sync-status", async (req, res) => {
  try {
    const jobs = await emailQueue.getJobs([
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
    ]);

    for (const job of jobs) {
      const state = await job.getState();

      const status =
        state === "completed"
          ? "sent"
          : state === "failed"
          ? "failed"
          : state === "active"
          ? "sending"
          : "scheduled";

      await pool.query(
        "UPDATE emails SET status = $1 WHERE job_id = $2",
        [status, String(job.id)]
      );
    }

    res.json({
      message:
        "PostgreSQL statuses synchronized successfully.",
    });
  } catch (error) {
    console.error(
      "Status sync failed:",
      error.message
    );

    res.status(500).json({
      message: "Status synchronization failed.",
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(
    `Bull Board: http://localhost:${PORT}/admin/queues`
  );
  console.log(
    `Google OAuth: http://localhost:${PORT}/auth/google`
  );
  console.log(
    `Email search: http://localhost:${PORT}/api/search?q=test`
  );
  console.log(
    `Elasticsearch health: http://localhost:${PORT}/api/elasticsearch/health`
  );
  console.log(
    `Slack health: http://localhost:${PORT}/api/slack/health`
  );
});