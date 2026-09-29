const app = require("./app");
const { env } = require("./config/env");
const { connectDatabase, closeDatabase } = require("./config/db");

const start = async () => {
    await connectDatabase();

    const server = app.listen(env.port, () => {
        console.log(`Routely API listening on port ${env.port} (${env.nodeEnv}).`);
        console.log(`Allowed client origins: ${env.clientUrls.join(", ") || "none"}`);
    });

    const shutdown = (signal) => {
        console.log(`\n${signal} received, shutting down.`);
        server.close(async () => {
            await closeDatabase();
            process.exit(0);
        });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
};

start().catch((error) => {
    console.error("Server startup failed:", error);
    process.exit(1);
});
