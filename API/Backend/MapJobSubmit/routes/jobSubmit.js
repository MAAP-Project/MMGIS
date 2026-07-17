const express = require("express");
const router = express.Router();
const logger = require("../../../logger");

// Proxy endpoint to fetch processes from the workflows API.
// Solves CORS issues by making the request server-side.
router.get("/processes", async (req, res) => {
    const baseUrl = req.query.baseUrl;

    if (!baseUrl) {
        return res.status(400).send({
            status: "failure",
            message: "baseUrl query parameter is required"
        });
    }

    try {
        const url = baseUrl.replace(/\/+$/, '') + '/processes';
        logger("info", `Proxying request to: ${url}`, req.originalUrl, req);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`Workflows API returned ${response.status}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (err) {
        logger(
            "error",
            "Failed to fetch processes from workflows API",
            req.originalUrl,
            req,
            err
        );
        res.status(500).send({
            status: "failure",
            message: "Failed to fetch processes",
            error: err.message
        });
    }
});

module.exports = router;
