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

// Proxy endpoint to fetch details for a specific process by processID.
// Returns the full process schema including inputs.
router.get("/processes/:processID", async (req, res) => {
    const baseUrl = req.query.baseUrl;
    const processID = req.params.processID;

    if (!baseUrl) {
        return res.status(400).send({
            status: "failure",
            message: "baseUrl query parameter is required"
        });
    }

    if (!processID) {
        return res.status(400).send({
            status: "failure",
            message: "processID is required"
        });
    }

    try {
        const url = baseUrl.replace(/\/+$/, '') + `/processes/${processID}`;
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
            "Failed to fetch process details from workflows API",
            req.originalUrl,
            req,
            err
        );
        res.status(500).send({
            status: "failure",
            message: "Failed to fetch process details",
            error: err.message
        });
    }
});

// Proxy endpoint to submit/execute a workflow job.
router.post("/processes/:processID/execution", async (req, res) => {
    const baseUrl = req.query.baseUrl;
    const processID = req.params.processID;
    const proxyTicket = req.headers['x-proxy-ticket'];

    if (!baseUrl) {
        return res.status(400).send({
            status: "failure",
            message: "baseUrl query parameter is required"
        });
    }

    if (!processID) {
        return res.status(400).send({
            status: "failure",
            message: "processID is required"
        });
    }

    try {
        const url = baseUrl.replace(/\/+$/, '') + `/processes/${processID}/execution`;
        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        };

        // Forward x-proxy-ticket header as proxy-ticket to MAAP API
        if (proxyTicket) {
            headers['proxy-ticket'] = proxyTicket;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(req.body),
        });

        if (!response.ok) {
            throw new Error(`Workflows API returned ${response.status}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (err) {
        logger(
            "error",
            "Failed to submit job to Workflows API",
            req.originalUrl,
            req,
            err
        );
        res.status(500).send({
            status: "failure",
            message: "Failed to submit job to Workflows API",
            error: err.message
        });
    }
});

// Proxy endpoint to get user jobs
router.get("/jobs", async (req, res) => {
    logger("warn", "in the get jobs endpoint")
    logger("info", `ALL request headers: ${JSON.stringify(req.headers)}`, req.originalUrl, req);
    const baseUrl = req.query.baseUrl;
    const proxyTicket = req.headers['x-proxy-ticket'];

    if (!baseUrl) {
        return res.status(400).send({
            status: "failure",
            message: "baseUrl query parameter is required"
        });
    }

    try {
        const url = baseUrl.replace(/\/+$/, '') + `/jobs`;
        const headers = {
            'Accept': 'application/json',
        };

        // Forward x-proxy-ticket header as proxy-ticket to MAAP API
        if (proxyTicket) {
            headers['proxy-ticket'] = proxyTicket;
        } else {
            logger("warn", `No proxy-ticket header received from client`, req.originalUrl, req);
        }

        const response = await fetch(url, {
            method: 'GET',
            headers: headers,
        });

        if (!response.ok) {
            const responseText = await response.text();
            logger("error", `MAAP API returned ${response.status}: ${responseText}`, req.originalUrl, req);
            throw new Error(`Workflows API returned ${response.status}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (err) {
        logger(
            "error",
            "Failed to fetch jobs details from Workflows API",
            req.originalUrl,
            req,
            err
        );
        res.status(500).send({
            status: "failure",
            message: "Failed to fetch job details from Workflows API",
            error: err.message
        });
    }
});

// Proxy endpoint to fetch available algorithm resources/queues
router.get("/resources", async (req, res) => {
    const baseUrl = req.query.baseUrl;
    const proxyTicket = req.headers['x-proxy-ticket'];

    try {
        const url = baseUrl.replace(/\/ogc\/?$/i, '').replace(/\/+$/, '') + `/mas/algorithm/resource`;
        logger("info", `Proxying request to: ${url}`, req.originalUrl, req);

        const headers = {
            'Accept': 'application/json',
        };

        // Forward x-proxy-ticket header as proxy-ticket to MAAP API
        if (proxyTicket) {
            headers['proxy-ticket'] = proxyTicket;
        } else {
            logger("warn", `No proxy-ticket header received from client for resources endpoint`, req.originalUrl, req);
        }

        const response = await fetch(url, {
            method: 'GET',
            headers: headers,
        });

        if (!response.ok) {
            const responseText = await response.text();
            logger("error", `MAAP API returned ${response.status}: ${responseText}`, req.originalUrl, req);
            throw new Error(`MAAP API returned ${response.status}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (err) {
        logger(
            "error",
            "Failed to fetch resources from MAAP API",
            req.originalUrl,
            req,
            err
        );
        res.status(500).send({
            status: "failure",
            message: "Failed to fetch resources",
            error: err.message
        });
    }
});

module.exports = router;
