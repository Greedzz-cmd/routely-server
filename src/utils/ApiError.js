/** Error carrying an HTTP status so controllers can throw instead of branching. */
class ApiError extends Error {
    constructor(status, message, details) {
        super(message);

        this.name = "ApiError";
        this.status = status;
        this.details = details;
    }

    static badRequest(message, details) {
        return new ApiError(400, message, details);
    }

    static unauthorized(message = "Authentication is required.") {
        return new ApiError(401, message);
    }

    static forbidden(message = "You do not have permission to perform this action.") {
        return new ApiError(403, message);
    }

    static notFound(message = "The requested resource was not found.") {
        return new ApiError(404, message);
    }

    static conflict(message) {
        return new ApiError(409, message);
    }

    static unavailable(message) {
        return new ApiError(503, message);
    }
}

module.exports = ApiError;
