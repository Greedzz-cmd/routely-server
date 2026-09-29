const dotenv = require("dotenv");

dotenv.config();

const toInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const toList = (value) =>
    String(value || "")
        .split(",")
        .map((item) => item.trim().replace(/\/+$/, ""))
        .filter(Boolean);

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

const authBaseUrl = (process.env.AUTH_BASE_URL || process.env.CLIENT_URL || "").replace(
    /\/+$/,
    ""
);

const env = {
    nodeEnv,
    isProduction,
    port: toInt(process.env.PORT, 5000),

    mongoUri: process.env.MONGODB_URI || "",
    mongoDb: process.env.MONGODB_DB || "routely",

    // Where Better Auth lives. JWTs issued there are verified against its JWKS.
    authBaseUrl,

    // Optional shared secret, used only when the client signs tokens with HS256.
    authSecret: process.env.AUTH_SECRET || "",

    clientUrls: toList(process.env.CLIENT_URLS || process.env.CLIENT_URL || authBaseUrl),

    payments: {
        // "mock" keeps the whole booking flow testable without Stripe keys.
        mode: (process.env.PAYMENTS_MODE || "mock").toLowerCase(),
        secretKey: process.env.STRIPE_SECRET_KEY || "",
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
        currency: (process.env.PAYMENT_CURRENCY || "bdt").toLowerCase(),
        successUrl:
            process.env.PAYMENT_SUCCESS_URL ||
            "http://localhost:3000/dashboard/user-dashboard/bookings?payment=success",
        cancelUrl:
            process.env.PAYMENT_CANCEL_URL ||
            "http://localhost:3000/dashboard/user-dashboard/bookings?payment=cancelled",
    },

    imgbbApiKey: process.env.IMGBB_API_KEY || "",
};

env.payments.isMock = env.payments.mode !== "stripe";

/**
 * Fails fast with an actionable message instead of crashing mid-request.
 * Only hard requirements are enforced; optional integrations degrade gracefully.
 */
const assertValidEnv = () => {
    const missing = [];

    if (!env.mongoUri) {
        missing.push("MONGODB_URI");
    }

    if (!env.authBaseUrl) {
        missing.push("AUTH_BASE_URL (or CLIENT_URL)");
    }

    if (env.payments.isMock && env.isProduction) {
        console.warn(
            "[env] PAYMENTS_MODE is 'mock' while NODE_ENV=production. " +
                "Set PAYMENTS_MODE=stripe with real keys before going live."
        );
    }

    if (!env.payments.secretKey && !env.payments.isMock) {
        throw new Error("STRIPE_SECRET_KEY is required when PAYMENTS_MODE=stripe.");
    }

    if (missing.length) {
        throw new Error(
            `Missing required environment variables: ${missing.join(", ")}. ` +
                "See .env.example for the full list."
        );
    }
};

module.exports = { env, assertValidEnv };
