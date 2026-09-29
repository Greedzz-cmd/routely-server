const { env } = require("./env");

/**
 * Vercel hands every preview deployment its own hostname, so a single hard
 * coded origin would reject browser requests with a CORS error. Preview hosts
 * are matched on their suffix instead.
 */
const isAllowedOrigin = (origin) => {
    if (!origin) {
        return true; // Same-origin and non-browser callers send no Origin header.
    }

    const normalized = origin.replace(/\/+$/, "");

    if (env.clientUrls.includes(normalized)) {
        return true;
    }

    if (!env.isProduction) {
        return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized);
    }

    return /\.vercel\.app$/.test(normalized);
};

const corsOptions = {
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error(`Origin "${origin}" is not allowed by CORS policy.`));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
};

module.exports = { corsOptions, isAllowedOrigin };
