
const { Queue } = require("bullmq");
require("dotenv").config();

const emailQueue = new Queue("emailQueue", {
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    username: process.env.REDIS_USERNAME || "default",
    password: process.env.REDIS_PASSWORD,
    
    maxRetriesPerRequest: null,
  },
});

emailQueue.on("error", (error) => {
  console.error("Redis queue error:", error.message);
});

module.exports = {
  emailQueue,
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    username: process.env.REDIS_USERNAME || "default",
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
  },
};
