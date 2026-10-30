
require("dotenv").config();

const { Worker } = require("bullmq");
const nodemailer = require("nodemailer");
const { connection } = require("./queue");
const pool = require("./db");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const worker = new Worker(
  "emailQueue",
  async (job) => {
    const { to, subject, message } = job.data;

    const result = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text: message,
    });

    console.log("Email sent:", result.messageId);

    return { messageId: result.messageId };
  },
  {
    connection,
    limiter: {
      max: 100,
      duration: 60 * 60 * 1000,
    },
  }
);

worker.on("completed", async (job) => {
  console.log(`Job ${job.id} completed`);

  try {
    await pool.query(
      "UPDATE emails SET status = $1 WHERE job_id = $2",
      ["sent", String(job.id)]
    );
    console.log("Database status updated: sent");
  } catch (error) {
    console.error("Database update error:", error.message);
  }
});

worker.on("failed", async (job, error) => {
  console.error(`Job ${job?.id} failed:`, error.message);

  if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
    try {
      await pool.query(
        "UPDATE emails SET status = $1 WHERE job_id = $2",
        ["failed", String(job.id)]
      );
      console.log("Database status updated: failed");
    } catch (dbError) {
      console.error("Database update error:", dbError.message);
    }
  }
});

worker.on("error", (error) => {
  console.error("Worker error:", error.message);
});

console.log("Email worker started with hourly rate limit");
