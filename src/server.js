const { createApp } = require("./app");
const { connectMongo, mongoose } = require("./db/mongoose");
const { PORT, MONGODB_URI } = require("./config/env");

async function start() {
  await connectMongo();
  console.log(`Mongo connected: ${MONGODB_URI}`);

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`hpinetbackend-next listening on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start hpinetbackend-next:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await mongoose.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await mongoose.disconnect();
  process.exit(0);
});
