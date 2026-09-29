const express = require("express");
const cors = require("cors");

const { env } = require("./config/env");
const { corsOptions } = require("./config/cors");
const routes = require("./routes");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");

const app = express();

app.set("trust proxy", 1);

app.use(cors(corsOptions));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        service: "routely-api",
        environment: env.nodeEnv,
        payments: env.payments.isMock ? "mock" : "stripe",
        uptime: Math.round(process.uptime()),
    });
});

app.get("/", (_req, res) => {
    res.json({ message: "Routely API is running.", health: "/health" });
});

app.use(routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
