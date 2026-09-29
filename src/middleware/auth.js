const { createRemoteJWKSet, jwtVerify } = require("jose");

const { env } = require("../config/env");
const ApiError = require("../utils/ApiError");

let remoteKeySet;
let verificationMode = env.authSecret ? "secret" : "jwks";

const getKeySet = () => {
    if (!remoteKeySet) {
        remoteKeySet = createRemoteJWKSet(
            new URL(`${env.authBaseUrl}/api/auth/jwks`)
        );
    }

    return remoteKeySet;
};

const decodeBearerToken = (req) => {
    const header = req.headers.authorization || "";

    return header.match(/^Bearer\s+(.+)$/i)?.[1] || null;
};

/**
 * Better Auth can mint either an RS256 token (verified against its published
 * JWKS) or an HS256 token (verified with the shared secret). Both are
 * supported so the API works whichever provider plugin the client enables.
 */
const verifyToken = async (token) => {
    const options = {
        issuer: env.authBaseUrl,
        audience: env.authBaseUrl,
    };

    if (verificationMode === "secret" && env.authSecret) {
        return jwtVerify(token, new TextEncoder().encode(env.authSecret), options);
    }

    try {
        return await jwtVerify(token, getKeySet(), options);
    } catch (error) {
        if (!env.authSecret) {
            throw error;
        }

        // Fall back to the shared secret before giving up.
        verificationMode = "secret";
        return jwtVerify(token, new TextEncoder().encode(env.authSecret), options);
    }
};

/** Rejects the request unless a valid Better Auth JWT is present. */
const requireAuth = async (req, res, next) => {
    const token = decodeBearerToken(req);

    if (!token) {
        next(ApiError.unauthorized("A bearer token is required."));
        return;
    }

    try {
        const { payload } = await verifyToken(token);

        req.user = payload;
        next();
    } catch (error) {
        console.error("JWT verification failed:", error.message);
        next(ApiError.unauthorized("Your session is invalid or has expired."));
    }
};

const readRole = (user) => String(user?.role || "user").toLowerCase();

/** Restricts a route to the listed roles. Must run after requireAuth. */
const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) {
        next(ApiError.unauthorized());
        return;
    }

    if (!roles.includes(readRole(req.user))) {
        next(ApiError.forbidden());
        return;
    }

    next();
};

const isAdmin = (user) => readRole(user) === "admin";

module.exports = { requireAuth, requireRole, isAdmin, readRole };
