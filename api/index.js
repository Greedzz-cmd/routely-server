const app = require("../src/app");
const { connectDatabase } = require("../src/config/db");

// Vercel invokes this handler per request. Keep the MongoClient cached by the
// module in warm instances, while ensuring it is ready before Express runs.
module.exports = async (req, res) => {
    try {
        await connectDatabase();
        return app(req, res);
    } catch (error) {
        console.error("Request startup failed:", error);
        if (!res.headersSent) {
            return res.status(503).json({
                error: "Service temporarily unavailable.",
            });
        }
    }
};
