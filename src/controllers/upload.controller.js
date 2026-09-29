const { env } = require("../config/env");
const asyncHandler = require("../middleware/asyncHandler");
const ApiError = require("../utils/ApiError");

const IMGBB_UPLOAD_URL = "https://api.imgbb.com/1/upload";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = /^image\/(png|jpe?g|webp|gif|avif)$/i;

const formatBytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/**
 * Forwards a base64 encoded image to imgBB and returns the hosted URL.
 *
 * The API key stays on the server; the browser never sees it. Vendors only, so
 * ticket imagery is not open to any signed in account.
 */
const uploadImage = asyncHandler(async (req, res) => {
    if (!env.imgbbApiKey) {
        throw ApiError.unavailable(
            "Image hosting is not configured. Set IMGBB_API_KEY on the server."
        );
    }

    const { image, name } = req.body || {};

    if (typeof image !== "string" || !image.trim()) {
        throw ApiError.badRequest("An image is required.");
    }

    const base64 = image.replace(/^data:image\/[a-z+.-]+;base64,/i, "").trim();

    if (!base64) {
        throw ApiError.badRequest("The image could not be decoded.");
    }

    // 4 base64 chars encode 3 bytes.
    const approxBytes = (base64.length * 3) / 4;

    if (approxBytes > MAX_UPLOAD_BYTES) {
        throw ApiError.badRequest(
            `Image is too large (max ${formatBytes(MAX_UPLOAD_BYTES)}).`
        );
    }

    const mimeMatch = image.match(/^data:(image\/[a-z+.-]+);base64,/i);
    const mimeType = mimeMatch?.[1];

    if (mimeType && !ALLOWED_MIME.test(mimeType)) {
        throw ApiError.badRequest("Only PNG, JPEG, WebP, GIF or AVIF images are allowed.");
    }

    const form = new FormData();

    form.append("key", env.imgbbApiKey);
    form.append("image", base64);

    if (name) {
        form.append("name", String(name).slice(0, 60));
    }

    const response = await fetch(IMGBB_UPLOAD_URL, { method: "POST", body: form });

    if (!response.ok) {
        console.error("imgBB upload failed:", response.status, await response.text());
        throw ApiError.unavailable("The image host rejected the upload. Try again.");
    }

    const payload = await response.json();

    if (!payload?.success || !payload?.data?.url) {
        throw ApiError.unavailable(payload?.error?.message || "Image upload failed.");
    }

    res.status(201).json({
        message: "Image uploaded.",
        url: payload.data.url,
        deleteUrl: payload.data.delete_url || null,
    });
});

/** Tells the client whether upload is possible, so the form can adapt. */
const getUploadStatus = asyncHandler(async (_req, res) => {
    res.json({ enabled: Boolean(env.imgbbApiKey), provider: "imgbb" });
});

module.exports = { uploadImage, getUploadStatus };
