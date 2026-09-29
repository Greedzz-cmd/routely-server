const { ObjectId } = require("mongodb");

const ApiError = require("../utils/ApiError");

const MONGO_DUPLICATE_KEY = 11000;

/** Converts thrown errors into a single JSON shape the client can rely on. */
// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
const errorHandler = (error, req, res, next) => {
    let status = error.status || 500;
    let message = error.message || "Something went wrong.";
    let details = error.details;

    if (error.code === MONGO_DUPLICATE_KEY) {
        status = 409;
        message = "That record already exists.";
    }

    if (error.name === "ValidationError") {
        status = 400;
        message = "The submitted data is invalid.";
    }

    if (error.name === "CastError") {
        status = 400;
        message = "Malformed identifier.";
    }

    // Anything unexpected is logged in full but never leaked to the browser.
    if (status >= 500) {
        console.error(`[error] ${req.method} ${req.originalUrl}:`, error);
        message = "An unexpected error occurred. Please try again.";
    }

    const body = { message };

    if (details) {
        body.details = details;
    }

    if (status >= 500 && process.env.NODE_ENV !== "production") {
        body.stack = error.stack;
    }

    res.status(status).json(body);
};

const notFoundHandler = (req, res, next) => {
    next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist.`));
};

/** Rejects malformed ids early so controllers receive a real ObjectId. */
const parseObjectId = (value, label = "id") => {
    if (!ObjectId.isValid(String(value))) {
        throw ApiError.badRequest(`Invalid ${label}.`);
    }

    return new ObjectId(String(value));
};

module.exports = { errorHandler, notFoundHandler, parseObjectId };
