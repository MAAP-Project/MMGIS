const router = require("./routes/jobSubmit");
const logger = require("../../logger");

// MapJobSubmit backend routes for proxying requests to external workflows API
// to avoid CORS issues.

let setup = {
    onceInit: (s) => {
        const path = s.ROOT_PATH + "/api/mapjobsubmit";
        logger("info", `Registering MapJobSubmit proxy route at: ${path}`, "MapJobSubmit");
        // Proxy endpoint for fetching processes (no auth required)
        s.app.use(
            path,
            s.checkHeadersCodeInjection,
            s.setContentType,
            router
        );
    },
    onceStarted: (s) => {},
    onceSynced: (s) => {},
};

module.exports = setup;
