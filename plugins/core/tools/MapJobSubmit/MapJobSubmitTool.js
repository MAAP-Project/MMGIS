import $ from 'jquery'
import './MapJobSubmitTool.css'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import ToolController_ from '@basics/ToolController_/ToolController_'

// mmgisAPI is intentionally accessed via window.mmgisAPI at call time rather
// than imported at module top. Importing it here creates a cycle through
// src/pre/tools.js → MapJobSubmitTool → mmgisAPI → LayerUtils that fails with
// "Cannot access '__WEBPACK_DEFAULT_EXPORT__' before initialization."

const VECTOR_EXTS = ['geojson', 'json', 'gpkg', 'kml']
const DEFAULT_POLL_INTERVAL_MS = 30000
const SUBMITTED_STORAGE_KEY = 'mmgis.workflows.submitted'
const SUBMITTED_MAX_ENTRIES = 100
const PAGE_SIZE = 10

// Terminal/completed job statuses - jobs with these statuses won't be refreshed
const TERMINAL_STATUSES = ['failed', 'successful', 'dismissed', 'job-failed', 'completed', 'cancelled']

// Input name variations for map-based parameters
const LAT_VARIATIONS = ['lat', 'latitude']
const LON_VARIATIONS = ['lon', 'lng', 'longitude']
const BBOX_VARIATIONS = ['bbox', 'boundingbox']

// Normalize input key by removing spaces, hyphens, underscores and converting to lowercase
function normalizeInputKey(key) {
    return String(key).toLowerCase().replace(/[-_\s]/g, '')
}

// Check if an input should be treated as numeric based on its key or type
function shouldBeNumeric(key, type) {
    if (!type) type = ''
    const typeLower = type.toLowerCase()

    // Explicit numeric types
    if (typeLower === 'number' || typeLower === 'integer' ||
        typeLower === 'float' || typeLower === 'double') {
        return true
    }

    // Lat/lon are always numeric
    const normalized = normalizeInputKey(key)
    if (LAT_VARIATIONS.includes(normalized) || LON_VARIATIONS.includes(normalized)) {
        return true
    }

    return false
}

// Per-user job history is stored server-side in the MMGIS DB
// (workflow_submissions table). All three helpers below talk to that API.
// Network failures are intentionally swallowed — the UI degrades gracefully
// rather than blocking submit on a transient MMGIS-side error.

function mmgisUrl(path) {
    const root =
        (window.mmgisglobal && window.mmgisglobal.ROOT_PATH) || ''
    return (root ? root + '/' : '') + path.replace(/^\//, '')
}

function mmgisFetch(path, init) {
    const headers = {
        Accept: 'application/json',
        ...((init && init.headers) || {}),
    }

    // Add x-proxy-ticket header if token is available (X- prefix is required for custom headers)
    if (Workflows.personalAccessToken) {
        headers['x-proxy-ticket'] = Workflows.personalAccessToken
        console.log('[MapJobSubmitTool] Adding x-proxy-ticket header to request:', path)
    } 

    return fetch(mmgisUrl(path), {
        credentials: 'same-origin',
        ...init,
        headers: headers,  
    })
}

// Returns { [workflow_id]: { endpoint, payload, name, ts } }
function fetchSubmittedRegistry() {
    console.log('[MapJobSubmitTool] Fetching submitted registry from DB...')
    // Include maap_user_id query param to filter by MAAP user
    const url = Workflows.maapUserId
        ? `api/mapjobsubmit-history?maap_user_id=${encodeURIComponent(Workflows.maapUserId)}`
        : 'api/mapjobsubmit-history'
    return mmgisFetch(url)
        .then((r) => {
            console.log('[MapJobSubmitTool] Registry fetch response status:', r.status)
            return r.json()
        })
        .then((d) => {
            console.log('[MapJobSubmitTool] Registry fetch data:', d)
            if (!d || d.status !== 'success' || !Array.isArray(d.body)) {
                console.warn('[MapJobSubmitTool] Invalid registry response format:', d)
                return {}
            }
            console.log('[MapJobSubmitTool] Registry has', d.body.length, 'entries')
            const out = {}
            d.body.forEach((row) => {
                if (!row || !row.workflow_id) return
                out[row.workflow_id] = {
                    endpoint: row.endpoint || '',
                    payload: row.payload || null,
                    name: row.name || '',
                    ts: row.created_on
                        ? new Date(row.created_on).getTime()
                        : Date.now(),
                }
            })
            console.log('[MapJobSubmitTool] Built registry with', Object.keys(out).length, 'jobs')
            return out
        })
        .catch((err) => {
            console.error('[MapJobSubmitTool] Failed to fetch registry:', err)
            return {}
        })
}

function recordSubmittedJob(jobId, endpoint, payload, name) {
    return mmgisFetch('api/mapjobsubmit-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            workflow_id: jobId,
            maap_user_id: Workflows.maapUserId || null,
            endpoint,
            payload,
            name: name || '',
        }),
    })
        .then((r) => r.json())
        .then((data) => {
            if (data && data.status === 'success') {
                console.log('[MapJobSubmitTool] Job recorded to DB successfully:', jobId)
                return data
            }
            throw new Error('Failed to record job')
        })
}

function updateJobName(jobId, name) {
    // Goes through the upsert route (not /rename) so naming a job this user
    // never submitted creates its history row instead of silently updating
    // zero rows.
    return mmgisFetch('api/mapjobsubmit-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_id: jobId, name: name || '' }),
    }).catch(() => {})
}

function deleteJobFromDatabase(jobId) {
    return mmgisFetch(`api/mapjobsubmit-history/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
    })
        .then((r) => r.json())
        .then((data) => {
            if (data && data.status === 'success') {
                console.log('[MapJobSubmitTool] Job deleted from DB successfully:', jobId)
                return data
            }
            throw new Error(data.message || 'Failed to delete job')
        })
        .catch((err) => {
            console.error('[MapJobSubmitTool] Failed to delete job from DB:', err)
            throw err
        })
}

// One-time migration from the old localStorage registry into the new
// DB-backed store. After successful upload, the localStorage key is cleared
// so we don't re-migrate every load. If MMGIS is unreachable, the legacy
// data is left in place to retry on the next open.
function migrateLegacyLocalStorageRegistry() {
    let raw
    try {
        raw = window.localStorage.getItem(SUBMITTED_STORAGE_KEY)
    } catch (e) {
        return Promise.resolve()
    }
    if (!raw) return Promise.resolve()
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        try {
            window.localStorage.removeItem(SUBMITTED_STORAGE_KEY)
        } catch (e2) {}
        return Promise.resolve()
    }
    if (!parsed || typeof parsed !== 'object') return Promise.resolve()
    const entries = Object.entries(parsed)
    if (entries.length === 0) {
        try {
            window.localStorage.removeItem(SUBMITTED_STORAGE_KEY)
        } catch (e) {}
        return Promise.resolve()
    }
    return Promise.all(
        entries.map(([jobId, data]) =>
            recordSubmittedJob(
                jobId,
                data.endpoint,
                data.payload,
                data.name || ''
            )
        )
    ).then(() => {
        try {
            window.localStorage.removeItem(SUBMITTED_STORAGE_KEY)
        } catch (e) {}
    })
}

// Algorithms fetched from the workflows API (baseUrl + '/processes')
// Shape: { processes: [{ id, title, description, version, deployedBy, processID, ... }] }
// This global gets populated asynchronously via fetchProcesses() when the tool opens.
let PROCESSES = []

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * Standard pattern used across MMGIS (WorkflowsTool, Config routes, etc.)
 */
function escapeHTML(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * Sanitizes user input by removing dangerous characters.
 * Based on F_.sanitize() and backend sanitizeInput() patterns.
 */
function sanitizeInput(str) {
    if (str == null) return ''
    // Remove potentially dangerous characters: < > ; { }
    // These could be used for XSS/injection attacks
    return String(str).replace(/[<>;{}]/g, '')
}

/**
 * Validates and sanitizes a personal access token.
 * Ensures tokens don't contain XSS/injection characters.
 */
function sanitizeToken(token) {
    if (!token || typeof token !== 'string') return null

    const trimmed = token.trim()
    if (trimmed.length === 0) return null

    // Check for dangerous characters that could indicate XSS attempt
    const dangerousChars = /[<>'"`;(){}[\]\\]/
    if (dangerousChars.test(trimmed)) {
        console.warn('[MapJobSubmitTool] Token contains potentially dangerous characters')
        return null
    }

    // Reasonable length limit (most tokens are 20-200 chars, allow up to 500)
    if (trimmed.length > 500) {
        console.warn('[MapJobSubmitTool] Token exceeds maximum length')
        return null
    }

    return trimmed
}

function normalizeStatus(s) {
    if (!s || typeof s !== 'string') return ''
    return s.toLowerCase()
}

function isTerminal(status) {
    const s = normalizeStatus(status)
    return TERMINAL_STATUSES.includes(s)
}

// Verify the personal access token by calling the /jobs endpoint.
// Returns true if valid, false if invalid (403 or other error).
function verifyToken() {
    const proxyUrl = 'api/mapjobsubmit/jobs?baseUrl=' + encodeURIComponent(Workflows.baseUrl)
    return mmgisFetch(proxyUrl)
        .then((r) => {
            if (r.status === 403) {
                console.warn('[MapJobSubmitTool] Token verification failed: 403 Forbidden')
                return false
            }
            if (!r.ok) {
                console.warn('[MapJobSubmitTool] Token verification failed:', r.status)
                return false
            }
            return r.json()
        })
        .then((data) => {
            if (data === false) return false // 403 or error
            console.log('[MapJobSubmitTool] Token verified successfully')
            return true
        })
        .catch((err) => {
            console.warn('[MapJobSubmitTool] verifyToken failed', err)
            return false
        })
}

// Fetch the MAAP user ID from the configured member info endpoint
// Returns the user ID if successful, null if failed
function fetchMaapUserId() {
    // Use the full URL from tool vars (required to be a full URL)
    const memberInfoUrl = Workflows.memberInfoUrl
    if (!memberInfoUrl) {
        console.error('[MapJobSubmitTool] memberInfoUrl not configured')
        return Promise.resolve(null)
    }
    const proxyUrl = 'api/mapjobsubmit/members/self?memberInfoUrl=' + encodeURIComponent(memberInfoUrl)
    console.log('[MapJobSubmitTool] Fetching user ID from URL:', memberInfoUrl)
    return mmgisFetch(proxyUrl)
        .then((r) => {
            if (!r.ok) {
                console.warn('[MapJobSubmitTool] Failed to fetch user ID:', r.status)
                return null
            }
            return r.json()
        })
        .then((data) => {
            if (!data || !data.id) {
                console.warn('[MapJobSubmitTool] No user ID in response:', data)
                return null
            }
            console.log('[MapJobSubmitTool] Fetched MAAP user ID:', data.id)
            return data.id
        })
        .catch((err) => {
            console.warn('[MapJobSubmitTool] fetchMaapUserId failed', err)
            return null
        })
}

// Fetch the list of available algorithms/processes from the workflows API.
// Uses MMGIS backend proxy to avoid CORS issues.
function fetchProcesses() {
    const proxyUrl = 'api/mapjobsubmit/processes?baseUrl=' + encodeURIComponent(Workflows.baseUrl)
    console.log('[MapJobSubmitTool] Fetching processes via proxy:', mmgisUrl(proxyUrl))
    return mmgisFetch(proxyUrl)
        .then((r) => r.json())
        .then((data) => {
            console.log('[MapJobSubmitTool] /processes response:', data)
            if (!data || !Array.isArray(data.processes)) {
                console.warn('[MapJobSubmitTool] /processes returned invalid shape:', data)
                return []
            }
            console.log('[MapJobSubmitTool] Fetched', data.processes.length, 'processes')
            return data.processes
        })
        .catch((err) => {
            console.warn('[MapJobSubmitTool] fetchProcesses failed', err)
            return []
        })
}

// Fetch details for a specific process including its input schema.
function fetchProcessDetails(processID) {
    const proxyUrl = `api/mapjobsubmit/processes/${processID}?baseUrl=` + encodeURIComponent(Workflows.baseUrl)
    console.log('[MapJobSubmitTool] Fetching process details via proxy:', mmgisUrl(proxyUrl))
    return mmgisFetch(proxyUrl)
        .then((r) => r.json())
        .then((data) => {
            console.log('[MapJobSubmitTool] Process details response:', data)
            return data
        })
        .catch((err) => {
            console.warn('[MapJobSubmitTool] fetchProcessDetails failed', err)
            return null
        })
}

// Fetch or parse available algorithm resources/queues based on configuration.
// Returns a promise that resolves to an array of queue names, or null if queues are disabled.
function fetchResources() {
    const resourcesConfig = Workflows.vars.resourcesConfig || ''

    // Mode 1: No configuration - queues disabled
    if (!resourcesConfig || resourcesConfig.trim() === '') {
        console.log('[MapJobSubmitTool] No resources configuration - queues disabled')
        return Promise.resolve(null)
    }

    // Mode 2: URL - fetch from API
    if (/^https?:\/\//i.test(resourcesConfig)) {
        const proxyUrl = 'api/mapjobsubmit/resources?resourcesUrl=' + encodeURIComponent(resourcesConfig)
        console.log('[MapJobSubmitTool] Fetching resources from URL via proxy:', mmgisUrl(proxyUrl))
        return mmgisFetch(proxyUrl)
            .then((r) => r.json())
            .then((data) => {
                console.log('[MapJobSubmitTool] Resources response:', data)
                // API returns { code, message, queues: [...] }
                // Extract the queues array
                if (data && Array.isArray(data.queues)) {
                    return data.queues
                }
                console.warn('[MapJobSubmitTool] No queues array in response:', data)
                return []
            })
            .catch((err) => {
                console.warn('[MapJobSubmitTool] fetchResources failed', err)
                return []
            })
    }

    // Mode 3: Comma-separated list - parse as static array
    console.log('[MapJobSubmitTool] Using static queue list from config')
    const queues = resourcesConfig.split(',')
        .map(q => q.trim())
        .filter(q => q.length > 0)
    return Promise.resolve(queues)
}

// Human-friendly label for a job's endpoint/processID. If we recognize the
// processID in our fetched PROCESSES list, return its title; otherwise prettify.
function endpointLabel(endpoint) {
    if (!endpoint) return ''
    // Try parsing as a processID integer if it looks like one
    const asInt = parseInt(endpoint, 10)
    if (!isNaN(asInt) && String(asInt) === String(endpoint)) {
        const proc = PROCESSES.find((p) => p.processID === asInt)
        if (proc) return proc.title || proc.id || `Process ${asInt}`
    }
    // Fallback: prettify the string
    return endpoint
        .replace(/^\/api\//, '')
        .replace(/_v\d+$/i, '')
        .replace(/[/_]+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
}

// TEMPORARY: see comment on the ENDPOINTS const above.
function isFilePathValue(v) {
    return typeof v === 'string' && v.startsWith('file://')
}

// Pull a status from the API response. Handles multiple formats:
// - MAAP API: { status: "failed" }
// - Legacy formats: { workflow_status: "...", job_status: "..." }
// Always returned lowercase to keep CSS classes consistent.
function readStatus(body) {
    if (!body) return ''
    return normalizeStatus(
        body.status || body.workflow_status || body.job_status || ''
    )
}

// Detect a STAC item URL — anything with /stac/... and /items/<id> in the
// path. Workflow responses put these in prod_description, sometimes
// comma-separated with duplicates.
function isStacItemUrl(u) {
    return (
        typeof u === 'string' &&
        /^https?:\/\//i.test(u) &&
        /\/stac\//i.test(u) &&
        /\/items\//i.test(u)
    )
}

// Extract URLs (http/https) from a free-form description field. The workflow
// API concatenates multiple entries with commas.
function urlsFromString(s) {
    if (typeof s !== 'string' || !s) return []
    const out = []
    const re = /https?:\/\/[^\s,]+/gi
    let m
    while ((m = re.exec(s))) out.push(m[0])
    return out
}

// Collect every output URI we can find on a workflow body. Walks:
//   - stages[].products[].products[].file_uris[]  (canonical file paths)
//   - stages[].products[].products[].prod_description (URLs, e.g. STAC items)
// Also tolerates flat strings and the obvious url/uri/href keys.
function extractOutputUris(body) {
    const uris = []
    const push = (u) => {
        if (typeof u === 'string' && u) uris.push(u)
    }
    if (!body || typeof body !== 'object') return uris
    push(body.output_uri)
    if (Array.isArray(body.output_uris)) body.output_uris.forEach(push)
    const stages = Array.isArray(body.stages) ? body.stages : []
    for (const stage of stages) {
        if (!stage || !Array.isArray(stage.products)) continue
        for (const outer of stage.products) {
            if (!outer) continue
            if (typeof outer === 'string') {
                push(outer)
                continue
            }
            const inner = Array.isArray(outer.products)
                ? outer.products
                : [outer]
            for (const item of inner) {
                if (!item) continue
                if (typeof item === 'string') {
                    push(item)
                    continue
                }
                if (Array.isArray(item.file_uris))
                    item.file_uris.forEach(push)
                push(item.url)
                push(item.uri)
                push(item.href)
                push(item.path)
                urlsFromString(item.prod_description).forEach(push)
            }
        }
    }
    // Dedupe while preserving first-seen order.
    return Array.from(new Set(uris))
}

// Pick the first URI we can actually load as a map layer, in preference order:
//   1. STAC item URLs (MMGIS's own stac-item: prefix handles COG/vector)
//   2. HTTP/HTTPS URLs with a vector extension (geojson/gpkg/kml/json)
//   3. WFS GetFeature URLs returning GeoJSON (heuristic on query string)
// s3://, file://, and non-viewable formats are shown in the panel but not
// auto-added.
function findAutoAddableUri(uris) {
    // Pass 1: STAC items.
    for (const u of uris) {
        if (isStacItemUrl(u)) return u
    }
    // Pass 2: HTTP vector files.
    for (const u of uris) {
        if (!/^https?:\/\//i.test(u)) continue
        const ext = (u.split('?')[0].split('.').pop() || '').toLowerCase()
        if (VECTOR_EXTS.includes(ext)) return u
    }
    // Pass 3: WFS GeoJSON.
    for (const u of uris) {
        if (
            /^https?:\/\//i.test(u) &&
            /GetFeature/i.test(u) &&
            /outputFormat=(application(\/|%2F)json|json)/i.test(u)
        )
            return u
    }
    return null
}

// Friendly endpoint label: prefer what we locally knew (the path the user
// submitted), then template_id, then nothing.
function readEndpoint(body, existingEndpoint) {
    if (existingEndpoint) return existingEndpoint
    if (body && typeof body.template_id === 'string') return body.template_id
    return ''
}

// For RUNNING workflows: pull the current stage name if available.
function readCurrentStage(body) {
    if (!body) return ''
    const stages = Array.isArray(body.stages) ? body.stages : []
    const idx =
        typeof body.current_stage_index === 'number'
            ? body.current_stage_index
            : -1
    if (idx >= 0 && idx < stages.length && stages[idx]) {
        return stages[idx].name || ''
    }
    return ''
}

// For FAILED workflows: prefer the top-level summary, fall back to the last
// stage with an error_message.
function readError(body) {
    if (!body) return ''
    if (typeof body.overall_error === 'string' && body.overall_error)
        return body.overall_error
    const stages = Array.isArray(body.stages) ? body.stages : []
    for (let i = stages.length - 1; i >= 0; i--) {
        const s = stages[i]
        if (s && typeof s.error_message === 'string' && s.error_message)
            return s.error_message
    }
    return ''
}

// Check if an input name suggests it should have map selection
function shouldShowMapSelect(key) {
    const normalized = normalizeInputKey(key)

    // Check for bbox variations
    if (BBOX_VARIATIONS.includes(normalized)) {
        return true
    }

    // Check for lat/lon variations
    if (LAT_VARIATIONS.includes(normalized) || LON_VARIATIONS.includes(normalized)) {
        return true
    }

    return false
}

// Get the map selection type for a given input
function getMapSelectType(key) {
    const normalized = normalizeInputKey(key)

    // Bounding box variations
    if (BBOX_VARIATIONS.includes(normalized)) {
        return 'bbox'
    }

    // Latitude/longitude variations
    if (LAT_VARIATIONS.includes(normalized) || LON_VARIATIONS.includes(normalized)) {
        return 'point'
    }

    return null
}

// Build a form from the API's input schema (inputs object from process details).
// Returns a function that collects the payload.
function buildFormFromInputs($parent, inputs, $queueSelect, $tagInput) {
    $parent.empty()
    if (!inputs || Object.keys(inputs).length === 0) {
        $parent.append('<div class="mjs-empty">No parameters required.</div>')
        return () => ({
            queue: ($queueSelect && $queueSelect.val()) || '',
            tag: ($tagInput && $tagInput.val().trim()) || '',
            inputs: {}
        })
    }

    const inputRefs = []

    // First pass: detect if we have both lat and lon fields
    let latKey = null
    let lonKey = null
    Object.keys(inputs).forEach((key) => {
        const normalized = normalizeInputKey(key)
        if (LAT_VARIATIONS.includes(normalized)) {
            latKey = key
        } else if (LON_VARIATIONS.includes(normalized)) {
            lonKey = key
        }
    })

    const hasLatLonPair = latKey && lonKey
    let lastLatLonField = null // Track the last lat or lon field to insert button after

    Object.entries(inputs).forEach(([key, input]) => {
        const id = `mjs-input-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`
        const $field = $('<div class="mjs-field"></div>')

        // Determine input type
        const inputType = (input.type || '').toLowerCase()

        // Check if this is a bbox field
        const isBbox = BBOX_VARIATIONS.includes(normalizeInputKey(key))

        // Label using the input name/key
        const typeLabel = inputType ? ` <span class="mjs-field-type">${escapeHTML(inputType)}</span>` : ''
        $field.append(
            `<div class="mjs-field-label"><label for="${id}">${escapeHTML(key)}</label>${typeLabel}</div>`
        )

        let $input
        if (isBbox) {
            // Special handling for bbox: 4 coordinate fields + format selector
            // Validate that type is string, array, or text
            if (inputType !== 'string' && inputType !== 'array' && inputType !== 'text') {
                $field.append(
                    '<div class="mjs-bbox-error">⚠ bbox must be string, array, or text type</div>'
                )
                $parent.append($field)
                return
            }

            // Create 4 input fields for bbox coordinates
            const $bboxGrid = $('<div class="mjs-bbox-grid"></div>')

            const $minLon = $('<input type="number" step="any" placeholder="Min Lon" class="mjs-bbox-input" data-bbox-field="min_lon" />')
            const $minLat = $('<input type="number" step="any" placeholder="Min Lat" class="mjs-bbox-input" data-bbox-field="min_lat" />')
            const $maxLon = $('<input type="number" step="any" placeholder="Max Lon" class="mjs-bbox-input" data-bbox-field="max_lon" />')
            const $maxLat = $('<input type="number" step="any" placeholder="Max Lat" class="mjs-bbox-input" data-bbox-field="max_lat" />')

            $bboxGrid.append(
                $('<div class="mjs-bbox-field"><label>Min Lon</label></div>').append($minLon)
            )
            $bboxGrid.append(
                $('<div class="mjs-bbox-field"><label>Min Lat</label></div>').append($minLat)
            )
            $bboxGrid.append(
                $('<div class="mjs-bbox-field"><label>Max Lon</label></div>').append($maxLon)
            )
            $bboxGrid.append(
                $('<div class="mjs-bbox-field"><label>Max Lat</label></div>').append($maxLat)
            )

            $field.append($bboxGrid)

            // Add "Submit as" text input showing the raw formatted values
            const $formatLabel = $('<div class="mjs-bbox-format-label">Submit as</div>')
            const $formatInput = $('<input type="text" class="mjs-bbox-format-input" readonly />')

            // Set initial placeholder text
            let placeholderText = ''
            if (inputType === 'array') {
                placeholderText = '[min_longitude, min_latitude, max_longitude, max_latitude]'
            } else {
                // string or text type
                placeholderText = 'min_longitude,min_latitude,max_longitude,max_latitude'
            }
            $formatInput.val(placeholderText)

            // Function to update the "Submit as" field with raw values
            const updateFormatDisplay = () => {
                const minLon = $minLon.val()
                const minLat = $minLat.val()
                const maxLon = $maxLon.val()
                const maxLat = $maxLat.val()

                if (minLon && minLat && maxLon && maxLat) {
                    let formatted = ''
                    if (inputType === 'array') {
                        formatted = `[${minLon}, ${minLat}, ${maxLon}, ${maxLat}]`
                    } else {
                        // string or text type
                        formatted = `${minLon},${minLat},${maxLon},${maxLat}`
                    }
                    $formatInput.val(formatted)
                } else {
                    // Show placeholder text when fields are empty
                    $formatInput.val(placeholderText)
                }
            }

            // Function to update the bbox rectangle on the map
            const updateBboxOnMap = () => {
                const minLon = parseFloat($minLon.val())
                const minLat = parseFloat($minLat.val())
                const maxLon = parseFloat($maxLon.val())
                const maxLat = parseFloat($maxLat.val())

                if (!isNaN(minLon) && !isNaN(minLat) && !isNaN(maxLon) && !isNaN(maxLat)) {
                    if (Map_ && Map_.map) {
                        const map = Map_.map
                        const L = window.L

                        // Remove existing rectangle if present
                        if (MapSelection.persistentLayers[key]) {
                            try {
                                map.removeLayer(MapSelection.persistentLayers[key])
                            } catch (err) {
                                console.warn('[MapJobSubmitTool] Failed to remove bbox layer:', err)
                            }
                        }

                        // Create a single rectangle (Leaflet handles wrapping automatically)
                        // Note: For dateline-crossing bboxes where minLon > maxLon,
                        // the rectangle will wrap around the world as intended
                        const rect = L.rectangle([[minLat, minLon], [maxLat, maxLon]], {
                            color: '#ff8800',
                            weight: 2,
                            fillOpacity: 0.2
                        }).addTo(map)

                        const crossesDateline = minLon > maxLon
                        const popupText = crossesDateline
                            ? `Selected Bbox (crosses dateline)<br>W: ${minLon.toFixed(6)}<br>S: ${minLat.toFixed(6)}<br>E: ${maxLon.toFixed(6)}<br>N: ${maxLat.toFixed(6)}<br><small>Spans ${(360 - (minLon - maxLon)).toFixed(1)}° longitude</small>`
                            : `Selected Bbox<br>W: ${minLon.toFixed(6)}<br>S: ${minLat.toFixed(6)}<br>E: ${maxLon.toFixed(6)}<br>N: ${maxLat.toFixed(6)}`
                        rect.bindPopup(popupText)

                        // Store the rectangle
                        MapSelection.persistentLayers[key] = rect
                    }
                }
            }

            // Update the format display and map whenever any bbox field changes
            $minLon.on('input', () => {
                updateFormatDisplay()
                updateBboxOnMap()
            })
            $minLat.on('input', () => {
                updateFormatDisplay()
                updateBboxOnMap()
            })
            $maxLon.on('input', () => {
                updateFormatDisplay()
                updateBboxOnMap()
            })
            $maxLat.on('input', () => {
                updateFormatDisplay()
                updateBboxOnMap()
            })

            $field.append($formatLabel)
            $field.append($formatInput)

            // Add "Select on Map" button
            const $mapBtn = $('<button type="button" class="mjs-map-select-btn mjs-bbox-map-btn" data-input-key="' + escapeHTML(key) + '">Select on Map</button>')
            $field.append($mapBtn)

            // Store reference to all bbox components
            inputRefs.push({
                key,
                type: inputType,
                isBbox: true,
                $minLon,
                $minLat,
                $maxLon,
                $maxLat,
                $formatInput
            })
        } else if (inputType === 'boolean') {
            // Boolean toggle switch
            const defaultValue = input.default != null ? input.default : false
            const checked = defaultValue === true || defaultValue === 'true'

            const $toggleWrapper = $('<div class="mjs-toggle-wrapper"></div>')
            $input = $('<input type="checkbox" class="mjs-toggle-input" />')
                .attr('id', id)
                .prop('checked', checked)
            const $slider = $('<span class="mjs-toggle-slider"></span>')

            // Make the slider clickable
            $slider.on('click', function() {
                $input.prop('checked', !$input.prop('checked'))
            })

            $toggleWrapper.append($input).append($slider)
            $field.append($toggleWrapper)
            inputRefs.push({ key, $input, type: inputType })
        } else {
            // Text input for all other types
            const defaultValue = input.default != null ? String(input.default) : ''
            $input = $('<input type="text" />')
                .attr('id', id)
                .attr('placeholder', input.placeholder || '')
                .val(defaultValue)

            // Check if this is a lat or lon field and we have a pair
            const isLatOrLon = LAT_VARIATIONS.includes(normalizeInputKey(key)) ||
                               LON_VARIATIONS.includes(normalizeInputKey(key))

            // Add map select button if applicable, but skip individual buttons for lat/lon if we have a pair
            if (shouldShowMapSelect(key) && !(hasLatLonPair && isLatOrLon)) {
                const $inputWrapper = $('<div class="mjs-input-with-btn"></div>')
                $inputWrapper.append($input)
                const $mapBtn = $('<button type="button" class="mjs-map-select-btn" data-input-key="' + escapeHTML(key) + '">Select on Map</button>')
                $inputWrapper.append($mapBtn)
                $field.append($inputWrapper)
            } else {
                $field.append($input)
            }
            inputRefs.push({ key, $input, type: inputType })
        }

        // Description if provided
        if (input.description) {
            $field.append(
                `<div class="mjs-field-description">${escapeHTML(input.description)}</div>`
            )
        }

        $parent.append($field)

        // Track if this is a lat or lon field for button placement
        if (hasLatLonPair && (key === latKey || key === lonKey)) {
            lastLatLonField = $field
        }
    })

    // Add a single "Select Point on Map" button after the last lat/lon field
    if (hasLatLonPair && lastLatLonField) {
        const $pointBtn = $('<button type="button" class="mjs-select-point-btn" data-lat-key="' + escapeHTML(latKey) + '" data-lon-key="' + escapeHTML(lonKey) + '">Select Point on Map</button>')
        lastLatLonField.after($pointBtn)

        // Add listeners to update the point marker when lat/lon fields change
        const $latInput = $(`#mjs-input-${latKey.replace(/[^A-Za-z0-9_-]/g, '_')}`)
        const $lonInput = $(`#mjs-input-${lonKey.replace(/[^A-Za-z0-9_-]/g, '_')}`)

        const updatePointOnMap = () => {
            const lat = parseFloat($latInput.val())
            const lon = parseFloat($lonInput.val())

            if (!isNaN(lat) && !isNaN(lon)) {
                if (Map_ && Map_.map) {
                    const map = Map_.map
                    const L = window.L

                    // Remove existing marker if present
                    const markerKey = 'latlon-pair'
                    if (MapSelection.persistentLayers[markerKey]) {
                        try {
                            map.removeLayer(MapSelection.persistentLayers[markerKey])
                        } catch (err) {
                            console.warn('[MapJobSubmitTool] Failed to remove point marker:', err)
                        }
                    }

                    // Create new marker
                    const marker = L.circleMarker([lat, lon], {
                        radius: 8,
                        color: '#00A9E0',
                        fillColor: '#00A9E0',
                        fillOpacity: 0.6,
                        weight: 2
                    }).addTo(map)
                    marker.bindPopup(`Selected Point<br>Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}`)

                    // Store the new marker
                    MapSelection.persistentLayers[markerKey] = marker
                }
            }
        }

        if ($latInput.length && $lonInput.length) {
            $latInput.on('input', updatePointOnMap)
            $lonInput.on('input', updatePointOnMap)
        }
    }

    return function collectPayload() {
        const inputs = {}
        inputRefs.forEach((ref) => {
            const { key, $input, type, isBbox } = ref

            if (isBbox) {
                // Collect bbox coordinates - use raw values as-is
                const minLon = parseFloat(ref.$minLon.val())
                const minLat = parseFloat(ref.$minLat.val())
                const maxLon = parseFloat(ref.$maxLon.val())
                const maxLat = parseFloat(ref.$maxLat.val())

                // Only add if all values are present
                if (!isNaN(minLon) && !isNaN(minLat) && !isNaN(maxLon) && !isNaN(maxLat)) {
                    console.log(`[MapJobSubmitTool] Submitting bbox: ${minLon},${minLat},${maxLon},${maxLat}`)

                    // Order: [min_longitude, min_latitude, max_longitude, max_latitude]
                    // Format based on the input type from the algorithm
                    if (type === 'array') {
                        inputs[key] = [minLon, minLat, maxLon, maxLat]
                    } else {
                        // String or text format: "min_lon,min_lat,max_lon,max_lat"
                        inputs[key] = `${minLon},${minLat},${maxLon},${maxLat}`
                    }
                }
            } else if (type === 'boolean') {
                inputs[key] = $input.is(':checked')
            } else {
                const val = $input.val()
                if (val !== '') {
                    // Convert to number if it's a numeric input type or lat/lon
                    if (shouldBeNumeric(key, type)) {
                        const num = parseFloat(val)
                        if (!isNaN(num)) {
                            inputs[key] = num
                        } else {
                            inputs[key] = val // Keep as string if conversion fails
                        }
                    } else {
                        inputs[key] = val
                    }
                }
            }
        })
        return {
            queue: ($queueSelect && $queueSelect.val()) || '',
            tag: ($tagInput && $tagInput.val().trim()) || '',
            inputs: inputs
        }
    }
}

function buildForm($parent, fields) {
    $parent.empty()
    if (!fields || fields.length === 0) {
        $parent.append('<div class="mjs-empty">No parameters.</div>')
        return () => ({})
    }
    const inputs = []
    let visibleCount = 0
    fields.forEach((f) => {
        // Hidden (explicit, or — TEMPORARY — file:// default): skip the DOM
        // entirely. The default still gets sent at collect-payload time.
        if (f.hidden || isFilePathValue(f.default)) {
            inputs.push({ f, $input: null })
            return
        }
        const id = `mjs-field-${f.name.replace(/[^A-Za-z0-9_-]/g, '_')}`
        const initial = f.default
        const initialStr = initial != null ? String(initial) : ''
        const $field = $('<div class="mjs-field"></div>')
        const lockedSuffix = f.readOnly
            ? ' <span class="mjs-field-locked">read-only</span>'
            : ''
        $field.append(
            `<div class="mjs-field-label"><label for="${id}">${escapeHTML(
                f.name
            )}</label><span class="mjs-field-type">${escapeHTML(
                f.type || ''
            )}${lockedSuffix}</span></div>`
        )
        let $input
        if (f.type === 'boolean') {
            $input = $('<input type="checkbox" />').attr('id', id)
            if (initial === true) $input.prop('checked', true)
        } else if (f.type === 'number' || f.type === 'integer') {
            $input = $('<input type="number" />')
                .attr('id', id)
                .attr('placeholder', initialStr)
                .val(initialStr)
            if (f.type === 'integer') $input.attr('step', '1')
            if (f.min != null) $input.attr('min', f.min)
            if (f.max != null) $input.attr('max', f.max)
        } else if (f.type === 'date') {
            $input = $('<input type="date" />').attr('id', id).val(initialStr)
        } else {
            $input = $('<input type="text" />')
                .attr('id', id)
                .attr('placeholder', initialStr)
                .val(initialStr)
        }
        if (f.readOnly) {
            $input.prop('disabled', true).addClass('mjs-input-readonly')
        }
        $field.append($input)
        if (f.description) {
            $field.append(
                `<div class="mjs-field-description">${escapeHTML(
                    f.description
                )}</div>`
            )
        }
        $parent.append($field)
        inputs.push({ f, $input })
        visibleCount++
    })
    if (visibleCount === 0) {
        $parent.append(
            '<div class="mjs-empty">All parameters hidden; defaults will be sent.</div>'
        )
    }
    return function collectPayload() {
        const out = {}
        inputs.forEach(({ f, $input }) => {
            let v
            if (f.hidden || f.readOnly || isFilePathValue(f.default)) {
                // Always emit the configured default — user can't change it
                // (either intentionally locked, or TEMPORARY file:// hiding).
                v = f.default
            } else if (f.type === 'boolean') {
                v = $input.is(':checked')
            } else if (f.type === 'number' || f.type === 'integer') {
                const raw = $input.val()
                if (raw !== '') v = Number(raw)
            } else {
                // Sanitize text inputs to prevent XSS
                const raw = $input.val()
                v = sanitizeInput(raw)
            }
            if (v !== undefined && v !== '') out[f.name] = v
        })
        return out
    }
}

// Pull {collection, item} out of a STAC item URL like
// http://host/stac/collections/<coll>/items/<item>. Returns null if not
// recognized.
function parseStacItemUrl(u) {
    const m = /\/stac\/collections\/([^/?#]+)\/items\/([^/?#]+)/i.exec(u)
    if (!m) return null
    return { collection: m[1], item: m[2] }
}

// Fixed RFC-format uuid — the Configure API's validator (uuidValidate)
// rejects human-readable ids and would regenerate them, breaking lookups.
const GROUP_UUID = 'c7a4f1de-2f04-4e6b-9c8d-3b1a2e5f6a70'
const GROUP_DISPLAY_NAME = 'Workflow Outputs'

// Get (or lazily create + register) the header group all workflow layers
// live under in the Layers panel. The same object reference is shared
// between L_.configData.layers and L_.layers.data, mirroring parseConfig.
function ensureWorkflowsGroup() {
    if (L_.layers.data[GROUP_UUID]) return L_.layers.data[GROUP_UUID]
    const header = {
        // Post-parse convention: name IS the uuid (LayersTool builds DOM ids
        // from name; display_name carries the label).
        name: GROUP_UUID,
        uuid: GROUP_UUID,
        display_name: GROUP_DISPLAY_NAME,
        type: 'header',
        expanded: true,
        visibility: true,
        sublayers: [],
    }
    L_.layers.data[GROUP_UUID] = header
    L_.layers.nameToUUID = L_.layers.nameToUUID || {}
    L_.layers.nameToUUID[GROUP_DISPLAY_NAME] = [GROUP_UUID]
    L_.layers.on = L_.layers.on || {}
    L_.layers.on[GROUP_UUID] = true // headers always start on
    L_.layers.opacity = L_.layers.opacity || {}
    L_.layers.opacity[GROUP_UUID] = 1
    L_.layers.dataFlat = L_.layers.dataFlat || []
    L_.layers.dataFlat.unshift(header)
    L_.configData.layers = L_.configData.layers || []
    L_.configData.layers.unshift(header)
    return header
}

// Markdown provenance blurb for the Layers panel's Information modal
// (LayerInfoModal renders layer.description through showdown).
function buildLayerDescription(jobId, job) {
    const lines = ['Generated by the Workflows tool.', '']
    if (job.name) lines.push(`**Run:** ${job.name}`)
    lines.push(`**Workflow:** \`${jobId}\``)
    if (job.endpoint) lines.push(`**Endpoint:** \`${job.endpoint}\``)
    if (job.payload && Object.keys(job.payload).length > 0) {
        // TEMPORARY: file:// values stripped from display, same as the job
        // tiles (see comment on ENDPOINTS).
        const entries = Object.entries(job.payload).filter(
            ([, v]) => !isFilePathValue(v)
        )
        if (entries.length > 0) {
            lines.push('', '**Parameters:**', '')
            lines.push('| Parameter | Value |')
            lines.push('| --- | --- |')
            entries.forEach(([k, v]) => {
                lines.push(`| \`${k}\` | \`${v}\` |`)
            })
        }
    }
    return lines.join('\n')
}

function buildLayerObjForJob(jobId, uri, job) {
    const uuid = jobId
    const base = {
        // MMGIS keys everything by uuid-as-name; display_name is the label.
        name: uuid,
        uuid,
        display_name: job.name || `Workflow ${jobId}`,
        description: buildLayerDescription(jobId, job),
        initialOpacity: 1,
        visibility: true,
        controlled: false,
        variables: {},
        // parseConfig stamps this on every layer; without it Map_ turns the
        // missing time into starttime/endtime of '' and the tile middleware
        // emits a `datetime=/` param that pgstac rejects.
        time: { enabled: false },
    }
    const stac = parseStacItemUrl(uri)
    if (stac) {
        // Piggy-back on MMGIS's stac-collection: handling — the workflow's
        // item lives in a per-user collection; adding the collection surfaces
        // the new item alongside any siblings via titilerpgstac tiles.
        return {
            ...base,
            type: 'tile',
            url: `stac-collection:${stac.collection}`,
            tileformat: 'wmts',
            minZoom: 0,
            // The config validator requires all three zoom fields on tile
            // layers (no defaults are filled for them).
            maxNativeZoom: 20,
            maxZoom: 20,
            style: {},
        }
    }
    // Vector: GeoJSON/GPKG/KML or WFS GetFeature returning JSON.
    return {
        ...base,
        type: 'vector',
        url: uri,
        style: {
            color: '#ff8800',
            fillColor: '#ff8800',
            fillOpacity: 0.5,
            weight: 2,
            radius: 6,
        },
    }
}

// Persist the layer into the mission's stored configuration via the
// Configure API so it survives reloads and reaches other users of the
// mission. Two-step, self-healing: first try placing the child inside the
// existing "Workflow Outputs" group; if the group doesn't exist in the
// stored config yet, create it (with the layer inside) at the top.
// Requires the MMGIS user to have mission-edit permission — failure is
// non-fatal (the layer stays for this session either way).
async function persistLayerToMission(layerObj) {
    const mission = L_.mission
    if (!mission) return false
    const post = (body) =>
        mmgisFetch('api/configure/addLayer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then((r) => r.json())
            .catch(() => ({ status: 'failure', message: 'network error' }))

    let r = await post({
        mission,
        layer: layerObj,
        placement: { path: GROUP_DISPLAY_NAME, index: 0 },
    })
    if (r.status === 'success') return true
    if (!/not found/i.test(String(r.message || ''))) {
        console.warn('[MapJobSubmitTool] persist failed:', r.message, r.errors || r.badUUIDs || '')
        return false
    }
    r = await post({
        mission,
        layer: {
            name: GROUP_DISPLAY_NAME,
            uuid: GROUP_UUID,
            type: 'header',
            expanded: true,
            visibility: true,
            sublayers: [layerObj],
        },
        placement: { index: 0 },
    })
    if (r.status === 'success') return true
    console.warn('[MapJobSubmitTool] persist failed:', r.message, r.errors || r.badUUIDs || '')
    return false
}

// Remove a run's layer everywhere: off the map, out of the L_ registries and
// the "Workflow Outputs" group, and (best-effort) out of the stored mission
// configuration.
async function removeLayerForJob(jobId, job) {
    const layerObj = L_.layers.data[jobId]
    if (layerObj) {
        try {
            // Detach from the map first if currently visible.
            if (L_.layers.on[jobId] === true) {
                await L_.toggleLayer(layerObj, true)
            }
        } catch (err) {
            console.warn('[MapJobSubmitTool] layer detach failed', err)
        }
        delete L_.layers.layer[jobId]
        delete L_.layers.data[jobId]
        delete L_.layers.on[jobId]
        delete L_.layers.opacity[jobId]
        if (L_.layers.attachments) delete L_.layers.attachments[jobId]
        if (L_._layersParent) delete L_._layersParent[jobId]
        const oi = (L_._layersOrdered || []).indexOf(jobId)
        if (oi !== -1) L_._layersOrdered.splice(oi, 1)
        const fi = (L_.layers.dataFlat || []).findIndex(
            (l) => l && l.uuid === jobId
        )
        if (fi !== -1) L_.layers.dataFlat.splice(fi, 1)
        const dn = layerObj.display_name
        if (dn && L_.layers.nameToUUID && L_.layers.nameToUUID[dn]) {
            const ni = L_.layers.nameToUUID[dn].indexOf(jobId)
            if (ni !== -1) L_.layers.nameToUUID[dn].splice(ni, 1)
            if (L_.layers.nameToUUID[dn].length === 0)
                delete L_.layers.nameToUUID[dn]
        }
        // The group header object is shared with configData, so splicing its
        // sublayers updates the config tree too.
        const group = L_.layers.data[GROUP_UUID]
        if (group && Array.isArray(group.sublayers)) {
            const si = group.sublayers.findIndex(
                (l) => l && l.uuid === jobId
            )
            if (si !== -1) group.sublayers.splice(si, 1)
        }
        const layersTool = ToolController_.getTool
            ? ToolController_.getTool('LayersTool')
            : null
        if (
            ToolController_.activeToolName === 'LayersTool' &&
            layersTool &&
            layersTool.destroy &&
            layersTool.make
        ) {
            layersTool.destroy()
            layersTool.make()
        }
    }
    job.layerAdded = false
    job.persisted = undefined
    Workflows.renderJobs()
    // Best-effort removal from the stored mission config; "not found" just
    // means it was session-only.
    mmgisFetch('api/configure/removeLayer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mission: L_.mission, layerUUID: jobId }),
    })
        .then((r) => r.json())
        .then((r) => {
            if (
                r.status !== 'success' &&
                !/not found|unable/i.test(String(r.message || ''))
            )
                console.warn(
                    '[MapJobSubmitTool] layer config removal:',
                    r.message
                )
        })
        .catch(() => {})
}

// Keep an added layer's label (and provenance description) in sync when the
// user renames the run — in-memory, in the Layers panel, and in the stored
// mission config when the layer was persisted there.
function syncLayerName(jobId) {
    const uuid = jobId
    const layerObj = L_.layers.data[uuid]
    if (!layerObj) return
    const job = Workflows.jobs[jobId] || {}
    layerObj.display_name = job.name || `Workflow ${jobId}`
    layerObj.description = buildLayerDescription(jobId, job)
    // dataFlat/configData hold the same object reference, so the Layers
    // panel picks the new label up on its next build; rebuild now if showing.
    const layersTool = ToolController_.getTool
        ? ToolController_.getTool('LayersTool')
        : null
    if (
        ToolController_.activeToolName === 'LayersTool' &&
        layersTool &&
        layersTool.destroy &&
        layersTool.make
    ) {
        layersTool.destroy()
        layersTool.make()
    }
    // Best-effort config sync — a "not found" just means the layer was never
    // persisted (session-only), which is fine.
    mmgisFetch('api/configure/updateLayer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mission: L_.mission,
            layerUUID: uuid,
            layer: {
                display_name: layerObj.display_name,
                description: layerObj.description,
            },
        }),
    })
        .then((r) => r.json())
        .then((r) => {
            if (
                r.status !== 'success' &&
                !/not found/i.test(String(r.message || ''))
            )
                console.warn('[MapJobSubmitTool] layer rename sync:', r.message)
        })
        .catch(() => {})
}

function addLayerForJob(jobId, job) {
    const uri = job.autoAddableUri
    if (!uri) return
    const uuid = jobId
    const layerObj = buildLayerObjForJob(jobId, uri, job)
    // Skip mmgisAPI.addLayer (it forgets to re-parse the config) and skip the
    // resetConfig path (re-runs parseConfig over every existing mission layer,
    // surfacing unrelated latent bugs in those layers). Splice the new layer
    // directly into the already-parsed L_ registries — nested under the
    // shared "Workflows" header group — and ask the map to render only it.
    ;(async () => {
        try {
            if (L_.layers.data[uuid]) {
                // Already present; nothing to do.
                job.layerAdded = true
                Workflows.renderJobs()
                return
            }
            const group = ensureWorkflowsGroup()
            group.sublayers.unshift(layerObj)
            L_.layers.data[uuid] = layerObj
            L_.layers.nameToUUID = L_.layers.nameToUUID || {}
            L_.layers.nameToUUID[layerObj.display_name] =
                L_.layers.nameToUUID[layerObj.display_name] || []
            L_.layers.nameToUUID[layerObj.display_name].push(uuid)
            L_._layersOrdered = L_._layersOrdered || []
            L_._layersOrdered.unshift(uuid)
            L_.layers.dataFlat = L_.layers.dataFlat || []
            L_.layers.dataFlat.unshift(layerObj)
            L_.layers.on = L_.layers.on || {}
            L_.layers.on[uuid] = true
            L_.layers.opacity = L_.layers.opacity || {}
            L_.layers.opacity[uuid] = 1
            L_._layersParent = L_._layersParent || {}
            L_._layersParent[uuid] = GROUP_UUID
            await L_.Map_.makeLayer(layerObj, true)
            // makeLayer only constructs the Leaflet layer; addVisible is
            // what actually attaches it to the map (same two-step
            // addLayerToLayersData performs).
            L_.addVisible(L_.Map_, [uuid])
            // Refresh the Layers panel if it happens to be showing.
            const layersTool = ToolController_.getTool
                ? ToolController_.getTool('LayersTool')
                : null
            if (
                ToolController_.activeToolName === 'LayersTool' &&
                layersTool &&
                layersTool.destroy &&
                layersTool.make
            ) {
                layersTool.destroy()
                layersTool.make()
            }
            job.layerAdded = true
            job.persisted = 'pending'
            Workflows.renderJobs()
            persistLayerToMission(layerObj).then((ok) => {
                job.persisted = ok
                Workflows.renderJobs()
            })
        } catch (err) {
            console.warn('[MapJobSubmitTool] addLayer failed', err)
        }
    })()
}

// ---- HTTP helpers ----

// Poll a specific job's status through the MMGIS proxy
// getJobDetails: optional boolean to request full job details (for import)
function pollJob(jobId, getJobDetails) {
    let proxyUrl = `api/mapjobsubmit/jobs/${encodeURIComponent(jobId)}?baseUrl=` + encodeURIComponent(Workflows.baseUrl)

    // Add getJobDetails parameter if requested
    if (getJobDetails) {
        proxyUrl += `&getJobDetails=true`
    }

    return mmgisFetch(proxyUrl)
        .then((r) => {
            if (!r.ok) {
                // Return the status so we can handle 404 vs other errors
                return r.json().catch(() => ({ error: true, status: r.status, statusText: r.statusText }))
            }
            return r.json()
        })
        .then((data) => {
            // Check if this is an error response
            if (data && data.error && data.status) {
                throw new Error(`HTTP ${data.status}: ${data.statusText || 'Job not found'}`)
            }
            return data || {}
        })
        .catch((err) => {
            // For normal polling, log and return empty
            // For import, the caller will handle the error
            console.warn('[MapJobSubmitTool] pollJob failed for', jobId, err)
            throw err
        })
}

// ---- Map Input Display State ----
const MapInputDisplay = {
    layers: {}, // jobId -> array of Leaflet layers

    show: function(jobId, payload) {
        // Clear any existing layers for this job
        this.clear(jobId)

        // Access the map through the imported Map_ module (same as Draw tool)
        if (!Map_ || !Map_.map) {
            console.warn('[MapJobSubmitTool] Map not available')
            window.alert('Map is not available')
            return
        }

        const map = Map_.map
        const L = window.L
        if (!L) {
            console.warn('[MapJobSubmitTool] Leaflet not available')
            window.alert('Leaflet library is not available')
            return
        }

        // Check if map has a valid CRS
        if (!map.options || !map.options.crs) {
            console.warn('[MapJobSubmitTool] Map CRS not initialized')
            window.alert('Map projection system is not ready. Please try again.')
            return
        }

        const layers = []

        // Check if payload has an 'inputs' wrapper (new format with queue/tag/inputs)
        const inputsToUse = payload.inputs || payload

        // Extract lat, lon, and bbox from payload
        let lat = null
        let lon = null
        let bbox = null

        Object.entries(inputsToUse).forEach(([key, value]) => {
            const normalized = normalizeInputKey(key)
            if (LAT_VARIATIONS.includes(normalized)) {
                lat = parseFloat(value)
            } else if (LON_VARIATIONS.includes(normalized)) {
                lon = parseFloat(value)
            } else if (BBOX_VARIATIONS.includes(normalized)) {
                bbox = value
            }
        })

        // Draw point if we have lat and lon (check for null/undefined first!)
        if (lat != null && lon != null && !isNaN(lat) && !isNaN(lon)) {
            console.log('[MapJobSubmitTool] Attempting to display point:', { lat, lon })
            try {
                const marker = L.circleMarker([lat, lon], {
                    radius: 8,
                    color: '#00A9E0',
                    fillColor: '#00A9E0',
                    fillOpacity: 0.6,
                    weight: 2
                }).addTo(map)
                marker.bindPopup(`Job Input<br>Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}`)
                layers.push(marker)
            } catch (err) {
                console.error('[MapJobSubmitTool] Failed to add point marker:', err)
                window.alert(`Failed to display point on map.\n\nCoordinates: ${lat}, ${lon}\nError: ${err.message}`)
                return
            }
        } else if (lat != null && !isNaN(lat)) {
            // Only lat - draw horizontal line across viewport
            console.log('[MapJobSubmitTool] Attempting to display latitude line:', lat)
            try {
                const bounds = map.getBounds()
                const west = bounds.getWest()
                const east = bounds.getEast()
                const line = L.polyline([[lat, west], [lat, east]], {
                    color: '#00A9E0',
                    weight: 2,
                    dashArray: '5, 5'
                }).addTo(map)
                line.bindPopup(`Job Input<br>Latitude: ${lat.toFixed(6)}`)
                layers.push(line)
            } catch (err) {
                console.error('[MapJobSubmitTool] Failed to add latitude line:', err)
                window.alert('Failed to display latitude line on map.')
                return
            }
        } else if (lon != null && !isNaN(lon)) {
            // Only lon - draw vertical line across viewport
            console.log('[MapJobSubmitTool] Attempting to display longitude line:', lon)
            try {
                const bounds = map.getBounds()
                const south = bounds.getSouth()
                const north = bounds.getNorth()
                const line = L.polyline([[south, lon], [north, lon]], {
                    color: '#00A9E0',
                    weight: 2,
                    dashArray: '5, 5'
                }).addTo(map)
                line.bindPopup(`Job Input<br>Longitude: ${lon.toFixed(6)}`)
                layers.push(line)
            } catch (err) {
                console.error('[MapJobSubmitTool] Failed to add longitude line:', err)
                window.alert('Failed to display longitude line on map.')
                return
            }
        }

        // Draw bounding box if we have it
        if (bbox) {
            console.log('[MapJobSubmitTool] Attempting to display bbox:', bbox)
            // Handle both string and array formats
            let parts
            if (Array.isArray(bbox)) {
                parts = bbox.map(v => parseFloat(v))
            } else {
                parts = String(bbox).split(',').map(s => parseFloat(s.trim()))
            }

            if (parts.length === 4 && parts.every(n => !isNaN(n))) {
                const [west, south, east, north] = parts
                console.log('[MapJobSubmitTool] Drawing bbox:', { west, south, east, north })

                try {
                    // Create a single rectangle (Leaflet handles wrapping automatically)
                    const rect = L.rectangle([[south, west], [north, east]], {
                        color: '#ffb74d',
                        fillColor: '#ffb74d',
                        fillOpacity: 0.15,
                        weight: 2
                    }).addTo(map)

                    // Check if this is a dateline-crossing bbox (west > east)
                    const crossesDateline = west > east
                    const popupText = crossesDateline
                        ? `Job Input (crosses dateline)<br>Bounding Box:<br>W: ${west}, S: ${south}<br>E: ${east}, N: ${north}<br><small>Spans ${(360 - (west - east)).toFixed(1)}° longitude</small>`
                        : `Job Input<br>Bounding Box:<br>W: ${west}, S: ${south}<br>E: ${east}, N: ${north}`
                    rect.bindPopup(popupText)

                    layers.push(rect)

                    // Zoom to bbox
                    map.fitBounds(rect.getBounds(), { padding: [50, 50] })
                } catch (err) {
                    console.error('[MapJobSubmitTool] Failed to add bounding box:', err)
                    console.error('[MapJobSubmitTool] Error stack:', err.stack)
                    window.alert(`Failed to display bounding box on map.\n\nBbox: ${bbox}\nError: ${err.message}`)
                    return
                }
            }
        }

        // If we drew anything, store the layers and zoom to fit all
        if (layers.length > 0) {
            this.layers[jobId] = layers

            // If we have multiple layers, create a group and zoom to all
            if (layers.length > 1) {
                const group = L.featureGroup(layers)
                map.fitBounds(group.getBounds(), { padding: [50, 50] })
            } else if (layers.length === 1 && !bbox) {
                // For single point or line, just pan to it (don't zoom)
                if (!isNaN(lat) && !isNaN(lon)) {
                    map.panTo([lat, lon])
                }
            }
        } else {
            window.alert('No valid map inputs found in this job.')
        }
    },

    clear: function(jobId) {
        if (this.layers[jobId]) {
            if (Map_ && Map_.map) {
                this.layers[jobId].forEach(layer => {
                    Map_.map.removeLayer(layer)
                })
            }
            delete this.layers[jobId]
        }
    },

    clearAll: function() {
        Object.keys(this.layers).forEach(jobId => {
            this.clear(jobId)
        })
    }
}

// ---- Map Selection State ----
const MapSelection = {
    active: false,
    type: null, // 'bbox' or 'point'
    inputKey: null,
    $targetInput: null, // For single input (point)
    $bboxInputs: null, // For bbox: {$minLon, $minLat, $maxLon, $maxLat}
    $latInput: null, // For lat/lon pair
    $lonInput: null, // For lat/lon pair
    drawing: null,
    clickHandler: null,
    persistentLayers: {}, // Map of inputKey -> layer, so each button has only one feature

    startPoint: function(latKey, lonKey, $latInput, $lonInput) {
        this.cancel() // Cancel any existing selection
        this.active = true
        this.type = 'point'
        this.inputKey = 'latlon-pair'
        this.$latInput = $latInput
        this.$lonInput = $lonInput

        if (!Map_ || !Map_.map) {
            console.warn('[MapJobSubmitTool] Map not available for selection')
            window.alert('Map is not available for selection')
            this.cancel()
            return
        }

        const map = Map_.map
        const L = window.L
        if (!L) {
            console.warn('[MapJobSubmitTool] Leaflet not available')
            window.alert('Leaflet library is not available')
            this.cancel()
            return
        }

        // Clear any existing layer for this button
        if (this.persistentLayers[this.inputKey]) {
            try {
                map.removeLayer(this.persistentLayers[this.inputKey])
            } catch (err) {
                console.warn('[MapJobSubmitTool] Failed to remove previous layer:', err)
            }
            delete this.persistentLayers[this.inputKey]
        }

        // Listen for a single click on the map
        this.clickHandler = (e) => {
            const lat = e.latlng.lat
            const lon = e.latlng.lng

            // Fill both lat and lon fields
            this.$latInput.val(lat.toFixed(6))
            this.$lonInput.val(lon.toFixed(6))

            // Add a persistent marker at the selected location
            const marker = L.circleMarker([lat, lon], {
                radius: 8,
                color: '#00A9E0',
                fillColor: '#00A9E0',
                fillOpacity: 0.6,
                weight: 2
            }).addTo(map)
            marker.bindPopup(`Selected Point<br>Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}`)

            // Store the marker so it persists until job submission (one per button)
            this.persistentLayers[this.inputKey] = marker

            this.cancel()
        }
        map.on('click', this.clickHandler)

        // Change cursor to crosshair
        map.getContainer().style.cursor = 'crosshair'
    },

    start: function(type, inputKey, $input, $bboxInputs) {
        this.cancel() // Cancel any existing selection
        this.active = true
        this.type = type
        this.inputKey = inputKey
        this.$targetInput = $input
        this.$bboxInputs = $bboxInputs

        if (!Map_ || !Map_.map) {
            console.warn('[MapJobSubmitTool] Map not available for selection')
            window.alert('Map is not available for selection')
            this.cancel()
            return
        }

        const map = Map_.map
        const L = window.L
        if (!L) {
            console.warn('[MapJobSubmitTool] Leaflet not available')
            window.alert('Leaflet library is not available')
            this.cancel()
            return
        }

        // Clear any existing layer for this button
        if (this.persistentLayers[this.inputKey]) {
            try {
                map.removeLayer(this.persistentLayers[this.inputKey])
            } catch (err) {
                console.warn('[MapJobSubmitTool] Failed to remove previous layer:', err)
            }
            delete this.persistentLayers[this.inputKey]
        }

        if (type === 'bbox') {
            // Use Leaflet Draw to draw a rectangle
            this.drawing = new L.Draw.Rectangle(map, {
                shapeOptions: {
                    color: '#ff8800',
                    weight: 2,
                    fillOpacity: 0.2
                }
            })
            this.drawing.enable()

            // Listen for the draw:created event
            const handler = (e) => {
                const layer = e.layer

                // Keep the drawn rectangle as-is on the map (don't alter it!)
                layer.addTo(map)

                // Get corner coordinates - use RAW values, don't normalize yet
                const latLngs = layer.getLatLngs()[0]
                const lngs = latLngs.map(ll => ll.lng)  // Keep raw values
                const lats = latLngs.map(ll => ll.lat)

                // Find the extremes - these are the RAW unwrapped coordinates
                const south = Math.min(...lats)
                const north = Math.max(...lats)
                const west = Math.min(...lngs)   // Can be < -180
                const east = Math.max(...lngs)   // Can be > 180

                console.log('[MapJobSubmitTool] Raw bbox from draw:', { west, south, east, north })

                // Display popup with raw coordinates
                const span = east - west
                const popupText = `Selected Bbox<br>W: ${west.toFixed(6)}<br>S: ${south.toFixed(6)}<br>E: ${east.toFixed(6)}<br>N: ${north.toFixed(6)}<br><small>Spans ${span.toFixed(1)}° longitude</small>`
                layer.bindPopup(popupText)

                // Store the drawn layer
                this.persistentLayers[this.inputKey] = layer

                // If we have bbox inputs object, populate the 4 fields
                if (this.$bboxInputs) {
                    this.$bboxInputs.$minLon.val(west.toFixed(6))
                    this.$bboxInputs.$minLat.val(south.toFixed(6))
                    this.$bboxInputs.$maxLon.val(east.toFixed(6))
                    this.$bboxInputs.$maxLat.val(north.toFixed(6))
                    // Trigger input event to update the "Submit as" field
                    this.$bboxInputs.$minLon.trigger('input')
                } else if (this.$targetInput) {
                    // Fallback: single string input
                    const bbox = [west, south, east, north].join(',')
                    this.$targetInput.val(bbox)
                }
                this.cancel()
            }
            map.on('draw:created', handler)
            this._drawCreatedHandler = handler
        } else if (type === 'point') {
            // Listen for a single click on the map
            this.clickHandler = (e) => {
                const lat = e.latlng.lat
                const lon = e.latlng.lng

                // Add a persistent marker at the selected location
                const marker = L.circleMarker([lat, lon], {
                    radius: 8,
                    color: '#00A9E0',
                    fillColor: '#00A9E0',
                    fillOpacity: 0.6,
                    weight: 2
                }).addTo(map)
                marker.bindPopup(`Selected Point<br>Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}`)

                // Store the marker so it persists until job submission (one per button)
                this.persistentLayers[this.inputKey] = marker

                // Check if this is for lat or lon specifically
                const keyLower = inputKey.toLowerCase().replace(/[-_\s]/g, '')
                if (keyLower === 'lat' || keyLower === 'latitude') {
                    this.$targetInput.val(lat.toFixed(6))
                } else if (keyLower === 'lon' || keyLower === 'lng' || keyLower === 'longitude') {
                    this.$targetInput.val(lon.toFixed(6))
                } else {
                    // Generic point - set as "lat,lon"
                    this.$targetInput.val(`${lat.toFixed(6)},${lon.toFixed(6)}`)
                }
                this.cancel()
            }
            map.on('click', this.clickHandler)

            // Change cursor to crosshair
            map.getContainer().style.cursor = 'crosshair'
        }
    },

    cancel: function() {
        if (!this.active) return

        if (Map_ && Map_.map) {
            const map = Map_.map
            if (this.drawing) {
                this.drawing.disable()
                this.drawing = null
            }
            if (this._drawCreatedHandler) {
                map.off('draw:created', this._drawCreatedHandler)
                this._drawCreatedHandler = null
            }
            if (this.clickHandler) {
                map.off('click', this.clickHandler)
                this.clickHandler = null
            }
            // Reset cursor
            map.getContainer().style.cursor = ''
        }

        this.active = false
        this.type = null
        this.inputKey = null
        this.$targetInput = null
    },

    clearPersistentLayers: function() {
        if (Map_ && Map_.map) {
            const map = Map_.map
            Object.keys(this.persistentLayers).forEach(key => {
                try {
                    map.removeLayer(this.persistentLayers[key])
                } catch (err) {
                    console.warn('[MapJobSubmitTool] Failed to remove layer:', err)
                }
            })
        }
        this.persistentLayers = {}
    }
}

// ---- Tool ----

const Workflows = {
    height: 0,
    width: 360,
    vars: null,
    baseUrl: '',
    accountCreationUrl: '',
    memberInfoUrl: '', // Full URL to member info endpoint, configurable in Configure UI
    selectedProcessID: null,
    selectedAlgorithmId: null,
    selectedVersion: null,
    selectedDeployer: null,
    jobs: {},
    jobIds: [],
    filterText: '',
    expandedIds: null, // initialized in make()
    paramsExpandedIds: null, // initialized in make()
    page: 0,
    pollTimer: null,
    authPollTimer: null,
    onAuthReady: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    personalAccessToken: null, // Stored in memory only for security
    maapUserId: null, // MAAP user ID from /api/members/self (stored in memory, not token)
    MMGISInterface: null,
    lastRefreshTime: null, // Track when jobs were last refreshed

    make: function () {
        Workflows.vars = L_.getToolVars('mapjobsubmit') || {}
        if (Workflows.vars.pollIntervalMs)
            Workflows.pollIntervalMs = Workflows.vars.pollIntervalMs
        // baseUrl is a tool variable (configurable in the Configure UI).
        // Fall back to the legacy top-level `workflows` config block for
        // missions configured before this moved.
        const legacy = (L_.configData && L_.configData.workflows) || {}
        Workflows.baseUrl = Workflows.vars.baseUrl || legacy.baseUrl || ''
        // accountCreationUrl is optional and configurable in the Configure UI
        Workflows.accountCreationUrl = Workflows.vars.accountCreationUrl || ''
        // memberInfoUrl is a full URL to the member info endpoint, configurable in the Configure UI
        Workflows.memberInfoUrl = Workflows.vars.memberInfoUrl || ''
        // resourcesConfig can be: URL, comma-separated list, or empty (disabled)
        Workflows.resourcesConfig = Workflows.vars.resourcesConfig || ''
        if (!Workflows.expandedIds) Workflows.expandedIds = new Set()
        if (!Workflows.paramsExpandedIds)
            Workflows.paramsExpandedIds = new Set()
        Workflows.MMGISInterface = new interfaceWithMMGIS()

        // Fetch processes immediately (no auth required)
        if (Workflows.baseUrl) {
            fetchProcesses().then((procs) => {
                PROCESSES = procs
                // Trigger UI update if the interface is ready
                if (typeof Workflows._populateAlgorithmDropdown === 'function') {
                    Workflows._populateAlgorithmDropdown()
                }
            })
        }

        // Don't load jobs on initial make() - wait for user to authenticate
        // Jobs will be loaded when user enters PAT and connects
    },

    destroy: function () {
        // Cancel any active map selection
        MapSelection.cancel()

        // Clear all map input displays
        MapInputDisplay.clearAll()

        if (Workflows.MMGISInterface)
            Workflows.MMGISInterface.separateFromMMGIS()
        Workflows.MMGISInterface = null
        if (Workflows.pollTimer) {
            clearInterval(Workflows.pollTimer)
            Workflows.pollTimer = null
        }
        if (Workflows.authPollTimer) {
            clearInterval(Workflows.authPollTimer)
            Workflows.authPollTimer = null
        }
        // Clear personal access token and MAAP user ID from memory
        Workflows.personalAccessToken = null
        Workflows.maapUserId = null
    },

    // Authenticates using a personal access token by verifying it with the /jobs endpoint
    connect: function (token) {
        // Sanitize and validate token
        const sanitized = sanitizeToken(token)
        if (!sanitized) {
            window.alert('Invalid token format. Please enter a valid personal access token.')
            return
        }
        Workflows.personalAccessToken = sanitized

        // Verify the token by calling /jobs endpoint (returns 403 if invalid)
        verifyToken().then((isValid) => {
            if (!isValid) {
                Workflows.personalAccessToken = null
                Workflows.maapUserId = null
                window.alert('Invalid personal access token. Please check your token and try again.')
                // Reset queue dropdown
                const $queueSelect = $('#mjs-queue-select')
                if ($queueSelect.length) {
                    $queueSelect.empty().append('<option value="">Enter PAT to see Queues</option>')
                    $queueSelect.attr('disabled', true)
                }
                if (typeof Workflows._renderUnauthenticated === 'function') {
                    Workflows._renderUnauthenticated()
                }
                return
            }

            // Token is valid - fetch MAAP user ID
            return fetchMaapUserId().then((userId) => {
                if (!userId) {
                    console.error('[MapJobSubmitTool] Failed to fetch MAAP user ID')
                    Workflows.personalAccessToken = null
                    Workflows.maapUserId = null
                    window.alert('Failed to fetch user information. Please try again.')
                    if (typeof Workflows._renderUnauthenticated === 'function') {
                        Workflows._renderUnauthenticated()
                    }
                    return
                }

                // Store user ID and render authenticated state
                Workflows.maapUserId = userId
                console.log('[MapJobSubmitTool] Authenticated as MAAP user:', userId)
                if (typeof Workflows._renderAuthenticated === 'function') {
                    Workflows._renderAuthenticated()
                }
            })
        }).catch(() => {
            Workflows.personalAccessToken = null
            Workflows.maapUserId = null
            window.alert('Failed to verify token. Please try again.')
            // Reset queue dropdown
            const $queueSelect = $('#mjs-queue-select')
            if ($queueSelect.length) {
                $queueSelect.empty().append('<option value="">Enter PAT to see Queues</option>')
                $queueSelect.attr('disabled', true)
            }
            if (typeof Workflows._renderUnauthenticated === 'function') {
                Workflows._renderUnauthenticated()
            }
        })
    },

    submit: function (processID, payload, name) {
        const proxyUrl = `api/mapjobsubmit/processes/${processID}/execution?baseUrl=` + encodeURIComponent(Workflows.baseUrl)
        console.log('[MapJobSubmitTool] Submitting job via proxy:', mmgisUrl(proxyUrl), 'with payload:', payload)
        return mmgisFetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
        })
            .then((r) => {
                // Check if response is successful (2xx status code)
                if (!r.ok) {
                    // Non-2xx response - parse error and reject
                    return r.json().then((errorData) => {
                        console.error('[MapJobSubmitTool] Job submission failed:', errorData)

                        // The proxy wraps the actual API error in the 'apiError' field
                        let actualError = errorData.apiError || errorData

                        // Extract error message from the actual API response
                        const errorMsg = actualError.detail || actualError.title || actualError.message || errorData.message || 'Unknown error'
                        const statusCode = errorData.statusCode || actualError.status || r.status

                        throw new Error(`Job submission failed (${statusCode}): ${errorMsg}`)
                    }).catch((jsonErr) => {
                        // If JSON parsing fails, throw a generic error
                        if (jsonErr.message && jsonErr.message.includes('Job submission failed')) {
                            throw jsonErr // Re-throw the error we just created
                        }
                        throw new Error(`Job submission failed (${r.status}): ${r.statusText}`)
                    })
                }
                return r.json()
            })
            .then((data) => {
                console.log('[MapJobSubmitTool] Job submit response:', data)
                const jobId = data.jobID
                if (!jobId) {
                    console.error('[MapJobSubmitTool] No job ID in response:', data)
                    throw new Error('No job ID in response')
                }
                console.log('[MapJobSubmitTool] Job submitted with ID:', jobId)
                Workflows.jobs[jobId] = {
                    endpoint: String(processID), // store processID as the endpoint identifier
                    payload: payload,
                    name: name || '',
                    status: readStatus(data) || 'queued',
                    startedAt: Date.now(),
                }
                // Prepend to ordered list and jump to first page so the user
                // sees their submission immediately.
                const i = Workflows.jobIds.indexOf(jobId)
                if (i !== -1) Workflows.jobIds.splice(i, 1)
                Workflows.jobIds.unshift(jobId)
                Workflows.page = 0
                console.log('[MapJobSubmitTool] Recording job to DB:', jobId)
                // Wait for DB write to complete before rendering to avoid race conditions
                return recordSubmittedJob(jobId, String(processID), payload, name)
                    .then(() => {
                        console.log('[MapJobSubmitTool] Job recorded to DB successfully')
                        console.log('[MapJobSubmitTool] Rendering jobs list')
                        Workflows.ensurePolling()
                        Workflows.renderJobs()
                        return jobId
                    })
                    .catch((err) => {
                        console.warn('[MapJobSubmitTool] Failed to record to DB, but showing in UI anyway:', err)
                        // Still render even if DB write fails
                        Workflows.ensurePolling()
                        Workflows.renderJobs()
                        return jobId
                    })
            })
            // NOTE: No .catch() here - let errors propagate to the caller so they can display to user
    },

    ensurePolling: function () {
        if (Workflows.pollTimer) return
        Workflows.pollTimer = setInterval(
            Workflows.pollAll,
            Workflows.pollIntervalMs
        )
    },

    refreshFromServer: function () {
        console.log('[MapJobSubmitTool] refreshFromServer called')

        // Check if authenticated before fetching jobs
        if (!Workflows.personalAccessToken) {
            console.log('[MapJobSubmitTool] Not authenticated - skipping job refresh')
            return Promise.resolve()
        }

        // Update the last refresh timestamp
        Workflows.lastRefreshTime = Date.now()
        updateLastRefreshDisplay()

        // Fetch job history from MMGIS DB (not from MAAP API)
        return fetchSubmittedRegistry()
            .then((reg) => {
                console.log('[MapJobSubmitTool] Fetched registry from DB:', Object.keys(reg).length, 'jobs')
                console.log('[MapJobSubmitTool] Registry data:', reg)
                // Merge registry data into Workflows.jobs
                Object.keys(reg).forEach((jobId) => {
                    if (!Workflows.jobs[jobId]) {
                        Workflows.jobs[jobId] = {
                            endpoint: reg[jobId].endpoint || '',
                            payload: reg[jobId].payload,
                            name: reg[jobId].name || '',
                            status: 'unknown',
                            startedAt: reg[jobId].ts || Date.now(),
                        }
                    } else {
                        // Update fields that might be missing
                        Workflows.jobs[jobId].payload =
                            Workflows.jobs[jobId].payload ||
                            reg[jobId].payload
                        Workflows.jobs[jobId].endpoint =
                            Workflows.jobs[jobId].endpoint ||
                            reg[jobId].endpoint
                        Workflows.jobs[jobId].name =
                            Workflows.jobs[jobId].name ||
                            reg[jobId].name ||
                            ''
                    }
                })

                // Build jobIds list from what we have in Workflows.jobs
                Workflows.jobIds = Object.keys(Workflows.jobs)
                    .sort(
                        (a, b) =>
                            (Workflows.jobs[b].startedAt || 0) -
                            (Workflows.jobs[a].startedAt || 0)
                    )

                console.log('[MapJobSubmitTool] Built jobIds list:', Workflows.jobIds.length, 'jobs')
                console.log('[MapJobSubmitTool] Job IDs:', Workflows.jobIds)

                // Clamp the current page in case the new list is shorter
                const maxPage = Math.max(
                    0,
                    Math.ceil(Workflows.jobIds.length / PAGE_SIZE) - 1
                )
                if (Workflows.page > maxPage) Workflows.page = maxPage

                console.log('[MapJobSubmitTool] Rendering jobs (before fetch details)')
                // Render immediately with what we have
                Workflows.renderJobs()

                // Fetch details for visible jobs
                return Workflows.fetchPageDetails()
            })
            .then(() => {
                Workflows.renderJobs()
                const hasActive = Object.values(Workflows.jobs).some(
                    (j) => !isTerminal(j.status)
                )
                if (hasActive) Workflows.ensurePolling()
            })
            .catch((err) => {
                console.warn('[MapJobSubmitTool] refresh failed', err)
            })
    },

    // The job ids currently visible given the text filter (matches tag,
    // job ID, or process name - case-insensitive partial match).
    getVisibleJobIds: function () {
        const f = Workflows.filterText
        if (!f) return Workflows.jobIds
        const filterLower = f.toLowerCase()
        return Workflows.jobIds.filter((id) => {
            const job = Workflows.jobs[id]
            if (!job) return false

            // Check job ID (partial match)
            if (id.toLowerCase().includes(filterLower)) return true

            // Check job name/tag (partial match)
            const name = job.name || ''
            if (name.toLowerCase().includes(filterLower)) return true

            // Check process name from endpoint (partial match)
            const endpoint = job.endpoint || ''
            if (endpoint.toLowerCase().includes(filterLower)) return true

            // Also check the human-friendly process label (partial match)
            const processLabel = endpointLabel(endpoint).toLowerCase()
            if (processLabel.includes(filterLower)) return true

            return false
        })
    },

    fetchPageDetails: function () {
        // Check if authenticated before fetching job details from MAAP API
        if (!Workflows.personalAccessToken) {
            console.log('[MapJobSubmitTool] Not authenticated - skipping fetch page details')
            return Promise.resolve()
        }

        const start = Workflows.page * PAGE_SIZE
        const slice = Workflows.getVisibleJobIds().slice(
            start,
            start + PAGE_SIZE
        )
        return Promise.all(
            slice.map((id) => {
                // Skip polling jobs that are already in a terminal state
                const job = Workflows.jobs[id]
                if (job && isTerminal(job.status)) {
                    console.log(`[MapJobSubmitTool] Skipping refresh for terminal job ${id} (status: ${job.status})`)
                    return Promise.resolve()
                }

                return pollJob(id)
                    .then((body) => mergeJobUpdate(id, body))
                    // One bad job must never sink the whole page's render.
                    .catch((err) => {
                        console.warn(
                            `[MapJobSubmitTool] detail fetch failed for ${id}`,
                            err
                        )
                        // Don't update the job on error - keep existing state
                    })
            })
        )
    },

    goToPage: function (n) {
        const maxPage = Math.max(
            0,
            Math.ceil(Workflows.getVisibleJobIds().length / PAGE_SIZE) - 1
        )
        const target = Math.max(0, Math.min(n, maxPage))
        if (target === Workflows.page) return
        Workflows.page = target
        Workflows.fetchPageDetails().then(() => Workflows.renderJobs())
        Workflows.renderJobs() // immediate render with whatever we have
    },

    pollAll: function () {
        // Check if authenticated before polling
        if (!Workflows.personalAccessToken) {
            console.log('[MapJobSubmitTool] Not authenticated - stopping poll timer')
            if (Workflows.pollTimer) {
                clearInterval(Workflows.pollTimer)
                Workflows.pollTimer = null
            }
            return
        }

        const ids = Object.keys(Workflows.jobs).filter(
            (id) => !isTerminal(Workflows.jobs[id].status)
        )
        if (ids.length === 0) {
            clearInterval(Workflows.pollTimer)
            Workflows.pollTimer = null
            return
        }
        ids.forEach((id) => {
            pollJob(id)
                .then((body) => {
                    const prev = Workflows.jobs[id]
                    if (!prev) return
                    const prevStatus = prev.status
                    mergeJobUpdate(id, body)
                    if (Workflows.jobs[id].status !== prevStatus)
                        Workflows.renderJobs()
                })
                .catch((err) => {
                    // Silently continue polling other jobs if one fails
                    console.warn(`[MapJobSubmitTool] pollAll failed for ${id}:`, err)
                })
        })
    },

    renderJobs: function () {
        const $list = $('#mapJobSubmitTool .mjs-jobs-list')
        console.log('[MapJobSubmitTool] renderJobs: found list element:', $list.length > 0)
        if ($list.length === 0) {
            console.warn('[MapJobSubmitTool] renderJobs: jobs list element not found!')
            return
        }
        $list.empty()

        // Bootstrap jobIds from Workflows.jobs the first time renderJobs runs
        // before refreshFromServer has populated the ordered list.
        if (Workflows.jobIds.length === 0) {
            Workflows.jobIds = Object.keys(Workflows.jobs).sort(
                (a, b) =>
                    (Workflows.jobs[b].startedAt || 0) -
                    (Workflows.jobs[a].startedAt || 0)
            )
        }

        const visibleIds = Workflows.getVisibleJobIds()
        const total = visibleIds.length
        if (total === 0) {
            $list.append(
                `<div class="mjs-empty">${
                    Workflows.filterText
                        ? 'No jobs match the filter.'
                        : 'No jobs yet.'
                }</div>`
            )
            renderPagination(0, 0, 0)
            return
        }

        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
        if (Workflows.page >= totalPages) Workflows.page = totalPages - 1
        const start = Workflows.page * PAGE_SIZE
        const pageIds = visibleIds.slice(start, start + PAGE_SIZE)

        pageIds.forEach((id) => {
            const job = Workflows.jobs[id] || { status: 'loading…', endpoint: '' }
            const statusClass = normalizeStatus(job.status) || 'loading'
            const isExpanded = Workflows.expandedIds.has(id)
            const $div = $('<div class="mjs-job"></div>')
            // Named runs show just the name (uuid available via tooltip and
            // the expanded drawer); unnamed runs fall back to the uuid.
            const primary = job.name
                ? `<span class="mjs-job-name" title="${escapeHTML(
                      id
                  )}">${escapeHTML(job.name)}</span>`
                : `<span class="mjs-job-id">${escapeHTML(id)}</span>`
            // Inline visibility checkbox on the tile itself once the layer
            // exists — no need to open the drawer just to toggle. The
            // mjs-layer-toggle handler stops propagation, so clicking it
            // doesn't expand/collapse the row.
            const layerExists = L_.layers.data[id] != null
            const tileVisibility = layerExists
                ? `<div class="mjs-tile-visibility mjs-layer-toggle" data-job-id="${escapeHTML(
                      id
                  )}" title="Toggle layer visibility">` +
                  `<div class="mjs-checkbox${
                      L_.layers.on[id] === true ? ' on' : ''
                  }"></div>` +
                  `</div>`
                : ''
            const $header = $(
                `<div class="mjs-job-header" data-job-id="${escapeHTML(id)}">` +
                    `<span class="mjs-job-chevron">${isExpanded ? '▼' : '▶'}</span> ` +
                    primary + ' ' +
                    `<span class="mjs-job-status ${escapeHTML(statusClass)}">${escapeHTML(job.status)}</span>` +
                    tileVisibility +
                    `</div>`
            )
            $div.append($header)
            if (job.endpoint) {
                $div.append(
                    `<div class="mjs-job-output" title="${escapeHTML(
                        job.endpoint
                    )}">${escapeHTML(endpointLabel(job.endpoint))}</div>`
                )
            }
            // Parameters are shown in the expanded section only, not in the collapsed tile view
            if (statusClass === 'running' && job.currentStage) {
                $div.append(
                    `<div class="mjs-job-stage">stage: ${escapeHTML(
                        job.currentStage
                    )}</div>`
                )
            }
            if (statusClass === 'failed' && job.error) {
                $div.append(
                    `<div class="mjs-job-error">${escapeHTML(job.error)}</div>`
                )
            }
            if (isExpanded) {
                $div.append(buildExpandedSection(job, id))
            }
            $list.append($div)
        })

        renderPagination(Workflows.page, totalPages, total)
    },
}

// Single source of truth for merging a backend response into Workflows.jobs.
// Preserves locally-known fields (the path the user actually submitted, our
// startedAt) and overlays the latest server state. Triggers layer add when
// a job first reaches completed with an output URI.
function mergeJobUpdate(id, body) {
    if (!body || typeof body !== 'object') return
    const existing = Workflows.jobs[id] || {}
    const status = readStatus(body) || existing.status || 'unknown'
    const freshUris = extractOutputUris(body)
    const output_uris =
        freshUris.length > 0
            ? freshUris
            : Array.isArray(existing.output_uris)
              ? existing.output_uris
              : []
    const next = {
        endpoint: readEndpoint(body, existing.endpoint),
        payload: existing.payload, // submitted payload sticks; server doesn't echo it
        name: existing.name || '', // client-side label
        status,
        output_uris,
        autoAddableUri:
            findAutoAddableUri(output_uris) || existing.autoAddableUri,
        currentStage:
            status === 'running' ? readCurrentStage(body) : undefined,
        error: status === 'failed' ? readError(body) : undefined,
        startedAt: existing.startedAt || Date.now(),
        layerAdded: existing.layerAdded,
        body: body, // full latest server response for the expanded view
        fromServer: true,
    }
    Workflows.jobs[id] = next
    // No auto-add: completed jobs with an addable output render an
    // "add as layer" button instead — the user decides what lands on the map.
}

// Compact value renderer for the always-visible params summary. For URI-like
// strings, show just the leaf (filename) — the path prefix is rarely useful
// at a glance and full value is available in the title tooltip + expand.
function formatParamValue(v) {
    if (v == null) return ''
    if (typeof v === 'string') {
        if (/^[a-z]+:\/\//i.test(v)) {
            const i = v.lastIndexOf('/')
            if (i > 0 && i < v.length - 1) return '…/' + v.slice(i + 1)
        }
        if (v.length > 60) return v.slice(0, 12) + '…' + v.slice(-30)
        return v
    }
    if (typeof v === 'object') {
        // Format objects as JSON for better readability
        try {
            return JSON.stringify(v)
        } catch (e) {
            return '[object]'
        }
    }
    return String(v)
}

// Parse an ISO-ish timestamp (the API returns naive UTC like "2026-06-02T23:20:50.586000")
// and render in the user's locale. Falls back to the raw string on bad input.
function formatLocale(iso) {
    if (!iso) return ''
    // The server's naive timestamps don't include a 'Z' suffix; FastAPI emits
    // UTC-but-unmarked. Append Z so Date doesn't interpret as local time.
    const s =
        typeof iso === 'string' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
            ? iso + 'Z'
            : iso
    const d = new Date(s)
    if (isNaN(d.getTime())) return String(iso)
    return d.toLocaleString()
}

// Check if job has any inputs that can be displayed on map
function hasMapDisplayableInputs(payload) {
    if (!payload || typeof payload !== 'object') return false

    // Check if payload has an 'inputs' wrapper (new format with queue/tag/inputs)
    const inputsToCheck = payload.inputs || payload

    return Object.keys(inputsToCheck).some(key => shouldShowMapSelect(key))
}

// Update the "Last refreshed" timestamp display
function updateLastRefreshDisplay() {
    const $display = $('#mjs-last-refresh')
    if (!$display.length) return

    if (!Workflows.lastRefreshTime) {
        $display.text('')
        return
    }

    const date = new Date(Workflows.lastRefreshTime)
    const timeString = date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    })

    $display.text(`Last refreshed: ${timeString}`)
}

function buildExpandedSection(job, jobId) {
    const $exp = $('<div class="mjs-job-expanded"></div>')

    // Workflow uuid — always shown at top of expanded section
    $exp.append(
        `<div class="mjs-exp-uuid" title="Workflow id">${escapeHTML(
            jobId
        )}</div>`
    )

    // Submitted params — only if we know them (locally submitted or hydrated
    // from the persistent registry). TEMPORARY: file:// values stripped.
    if (job.payload && Object.keys(job.payload).length > 0) {
        const display = Object.fromEntries(
            Object.entries(job.payload).filter(
                ([, v]) => !isFilePathValue(v)
            )
        )
        if (Object.keys(display).length > 0) {
            $exp.append('<div class="mjs-exp-label">Submitted parameters</div>')
            const $pre = $('<pre class="mjs-exp-json"></pre>')
            $pre.text(JSON.stringify(display, null, 2))
            $exp.append($pre)

            // Add "View Inputs on Map" button if job has mappable inputs
            if (hasMapDisplayableInputs(job.payload)) {
                const isShowing = MapInputDisplay.layers[jobId] && MapInputDisplay.layers[jobId].length > 0
                const $viewBtn = $(
                    `<button type="button" class="mjs-view-inputs-btn" data-job-id="${escapeHTML(jobId)}">${
                        isShowing ? 'Hide Inputs from Map' : 'View Inputs on Map'
                    }</button>`
                )
                $exp.append($viewBtn)
            }
        }
    } else if (job.fromServer) {
        $exp.append(
            '<div class="mjs-exp-hint">No submitted parameters on record (job was likely submitted from elsewhere or before this browser stored them).</div>'
        )
    }

    // Raw output URIs are intentionally NOT listed (s3/internal paths are
    // noise to end users) — just the layer controls for the loadable output.
    {
        const statusClass = normalizeStatus(job.status)
        const visible = L_.layers.on[jobId] === true

        if (statusClass === 'completed' && job.autoAddableUri) {
            // A layer counts as added if we added it this session OR it was
            // persisted to the mission config earlier and came in via the
            // normal config parse on load.
            const added =
                job.layerAdded ||
                L_.layers.data[jobId] != null
            // Two explicit controls: "Add layer" (one-time) and a visibility
            // toggle that's only live once the layer exists on the map.
            const $row = $('<div class="mjs-map-btn-row"></div>')
            $row.append(
                `<button type="button" class="mjs-map-btn mjs-layer-add" data-job-id="${escapeHTML(
                    jobId
                )}"${added ? ' disabled' : ''}>${
                    added ? 'Layer added' : 'Add layer'
                }</button>`
            )
            // Visibility control styled like the Layers panel's filled
            // checkbox. The mjs-layer-toggle handler no-ops until the layer
            // actually exists on the map.
            $row.append(
                `<div class="mjs-layer-visibility mjs-layer-toggle${
                    added ? '' : ' disabled'
                }" data-job-id="${escapeHTML(jobId)}" title="${
                    added
                        ? 'Toggle layer visibility'
                        : 'Add the layer first'
                }">` +
                    `<div class="mjs-checkbox${
                        added && visible ? ' on' : ''
                    }"></div>` +
                    `<span>Visible</span>` +
                    `</div>`
            )
            $exp.append($row)
            if (added) {
                $exp.append(
                    `<button type="button" class="mjs-map-btn mjs-layer-remove" data-job-id="${escapeHTML(
                        jobId
                    )}">Remove layer</button>`
                )
            }
            if (job.persisted === 'pending') {
                $exp.append(
                    '<div class="mjs-exp-hint">Saving to mission configuration…</div>'
                )
            } else if (job.persisted === true) {
                $exp.append(
                    '<div class="mjs-exp-hint">Saved to mission configuration — persists across reloads.</div>'
                )
            } else if (job.persisted === false) {
                $exp.append(
                    '<div class="mjs-exp-hint">Added for this session only — could not save to the mission configuration (this needs mission-edit permission).</div>'
                )
            } else if (added && !job.layerAdded) {
                $exp.append(
                    '<div class="mjs-exp-hint">Layer is saved in the mission configuration.</div>'
                )
            }
        }
    }

    // Server-side metadata, when present.
    const body = job.body
    if (body) {
        if (body.created_at || body.updated_at) {
            $exp.append('<div class="mjs-exp-label">Timing</div>')
            const lines = []
            if (body.created_at)
                lines.push(`created: ${formatLocale(body.created_at)}`)
            if (body.updated_at)
                lines.push(`updated: ${formatLocale(body.updated_at)}`)
            $exp.append(
                `<div class="mjs-exp-hint">${escapeHTML(lines.join(' · '))}</div>`
            )
        }
        if (Array.isArray(body.stages) && body.stages.length > 0) {
            $exp.append('<div class="mjs-exp-label">Stages</div>')
            const $stages = $('<div class="mjs-exp-stages"></div>')
            body.stages.forEach((s, i) => {
                const sclass = normalizeStatus(s && s.status) || 'unknown'
                const isCurrent = i === body.current_stage_index
                const $row = $(
                    `<div class="mjs-exp-stage ${escapeHTML(sclass)}${
                        isCurrent ? ' current' : ''
                    }">` +
                        `<span class="mjs-exp-stage-status">${escapeHTML(
                            s.status || ''
                        )}</span> ` +
                        `<span class="mjs-exp-stage-name">${escapeHTML(
                            s.name || ''
                        )}</span>` +
                        (s.subsystem
                            ? ` <span class="mjs-exp-stage-sub">[${escapeHTML(
                                  s.subsystem
                              )}]</span>`
                            : '') +
                        `</div>`
                )
                if (s.error_message) {
                    $row.append(
                        `<div class="mjs-exp-stage-error">${escapeHTML(
                            s.error_message
                        )}</div>`
                    )
                }
                $stages.append($row)
            })
            $exp.append($stages)
        }
    }

    // Remove Job button - always shown at the bottom
    $exp.append('<div class="mjs-exp-label" style="margin-top: 20px;">Actions</div>')
    $exp.append(
        `<button type="button" class="mjs-remove-job-btn" data-job-id="${escapeHTML(
            jobId
        )}">Remove Job</button>`
    )

    return $exp
}

function renderPagination(page, totalPages, total) {
    const $container = $('#mapJobSubmitTool .mjs-pagination')
    if ($container.length === 0) return
    $container.empty()
    if (totalPages <= 1) return
    const $prev = $(
        '<button type="button" class="mjs-page-btn mjs-page-prev">Prev</button>'
    )
    if (page === 0) $prev.attr('disabled', true)
    $prev.on('click', () => Workflows.goToPage(Workflows.page - 1))
    const $next = $(
        '<button type="button" class="mjs-page-btn mjs-page-next">Next</button>'
    )
    if (page >= totalPages - 1) $next.attr('disabled', true)
    $next.on('click', () => Workflows.goToPage(Workflows.page + 1))
    const $label = $(
        `<span class="mjs-page-label">Page ${page + 1} of ${totalPages} · ${total} jobs</span>`
    )
    $container.append($prev).append($label).append($next)
}

function interfaceWithMMGIS() {
    const tools = $('#toolPanel')
    tools.css({
        background: 'var(--color-k)',
        'box-shadow': 'inset 2px 0px 10px 0px rgba(0,0,0,0.2)',
    })
    tools.empty()
    tools.html('<div id="mapJobSubmitTool" class="mmgisScrollbar"></div>')
    const $root = $('#mapJobSubmitTool')
    $root.append('<div class="mjs-header">Workflows</div>')

    const $authBanner = $('<div id="mjs-auth-banner"></div>')
    $root.append($authBanner)

    // Form content wrapper - will be hidden until authenticated
    const $formContent = $('<div id="mjs-form-content" style="display: none;"></div>')

    // Algorithm selection dropdowns (3-step: id → version → deployer)
    $formContent.append('<div class="mjs-section-label">Algorithm</div>')
    const $algorithmSelect = $('<select id="mjs-algorithm-select"><option value="">Select algorithm...</option></select>')
    $formContent.append($algorithmSelect)

    $formContent.append('<div class="mjs-section-label">Version</div>')
    const $versionSelect = $('<select id="mjs-version-select" disabled><option value="">Select version...</option></select>')
    $formContent.append($versionSelect)

    $formContent.append('<div class="mjs-section-label">Deployer</div>')
    const $deployerSelect = $('<select id="mjs-deployer-select" disabled><option value="">Select deployer...</option></select>')
    $formContent.append($deployerSelect)

    $formContent.append('<div class="mjs-endpoint-desc" id="mjs-endpoint-desc"></div>')

    // Queue section - wrapped in a container for easy show/hide
    const $queueSection = $('<div class="mjs-queue-section"></div>')
    $queueSection.append('<div class="mjs-section-label">Queue</div>')
    const $queueSelect = $('<select id="mjs-queue-select" disabled></select>')
    $queueSelect.append('<option value="">Enter token to see queues</option>')
    $queueSection.append($queueSelect)
    $formContent.append($queueSection)

    $formContent.append('<div class="mjs-section-label">Tag</div>')
    const $tagInput = $(
        '<input type="text" id="mjs-submit-name" class="mjs-name-input" placeholder="e.g. test_default_inputs" />'
    )
    $formContent.append($tagInput)

    $formContent.append('<div class="mjs-section-label">Parameters</div>')
    const $form = $('<div id="mjs-form"></div>')
    $formContent.append($form)

    const $submit = $('<button class="mjs-submit" disabled>Loading…</button>')
    $formContent.append($submit)

    $root.append($formContent)

    $root.append(
        '<div class="mjs-jobs"><div class="mjs-jobs-header"><div class="mjs-section-label">Jobs</div><div class="mjs-jobs-header-btns"><button class="mjs-import-btn" type="button">Import Job</button><button class="mjs-refresh-btn" type="button">Refresh</button><span class="mjs-last-refresh" id="mjs-last-refresh"></span></div></div><input type="text" class="mjs-jobs-filter" placeholder="Filter by name or id…" spellcheck="false" /><div class="mjs-jobs-list"></div><div class="mjs-pagination"></div></div>'
    )
    // Don't call renderJobs() here - it will be called after authentication in renderAuthenticated()

    let filterFetchTimer = null
    $root.find('.mjs-jobs-filter').on('input', function () {
        Workflows.filterText = ($(this).val() || '').trim().toLowerCase()
        Workflows.page = 0
        Workflows.renderJobs()
        // Fetch details for the newly visible page, lightly debounced so
        // fast typing doesn't spray requests.
        clearTimeout(filterFetchTimer)
        filterFetchTimer = setTimeout(() => {
            Workflows.fetchPageDetails().then(() => Workflows.renderJobs())
        }, 300)
    })

    $root.find('.mjs-refresh-btn').on('click', function () {
        console.log('[MapJobSubmitTool] Refresh button clicked')
        const $btn = $(this)
        $btn.attr('disabled', true).text('Refreshing…')
        Workflows.refreshFromServer().finally(() => {
            $btn.attr('disabled', false).text('Refresh')
        })
    })

    $root.find('.mjs-import-btn').on('click', function () {
        const jobId = window.prompt('Enter Job ID to import:')
        if (!jobId || !jobId.trim()) return

        const trimmedJobId = jobId.trim()

        // Check if job already exists
        if (Workflows.jobs[trimmedJobId]) {
            window.alert('Job already present in your jobs list.')
            return
        }

        const $btn = $(this)
        $btn.attr('disabled', true).text('Importing…')

        // Fetch job details from API with getJobDetails=true
        pollJob(trimmedJobId, true)
            .then((body) => {
                if (!body || Object.keys(body).length === 0) {
                    window.alert('Job not found or returned empty data. Please check the Job ID and try again.')
                    return
                }

                // Extract inputs from the API response
                // The API returns inputs as an array of objects with name, destination, and value
                let payload = {}
                console.log('[MapJobSubmitTool] Importing job with body:', body)
                console.log('[MapJobSubmitTool] Raw inputs from API:', body.inputs)

                if (Array.isArray(body.inputs)) {
                    // Convert array format to object format for storage
                    body.inputs.forEach((input) => {
                        if (input.name && input.value !== undefined && input.value !== null) {
                            payload[input.name] = input.value
                        }
                    })
                    console.log('[MapJobSubmitTool] Converted inputs array to object:', payload)
                } else if (body.inputs && typeof body.inputs === 'object') {
                    // Already in object format
                    payload = body.inputs
                }

                console.log('[MapJobSubmitTool] Final payload with', Object.keys(payload).length, 'inputs')

                // Create job entry using processID from body
                const status = readStatus(body) || 'unknown'
                // Use process_name as endpoint if available, otherwise use processID
                const endpoint = body.process_name || (body.processID ? String(body.processID) : readEndpoint(body, null))

                // Use tags[0] as the primary name, fallback to title, then to empty string
                const jobName = (Array.isArray(body.tags) && body.tags.length > 0)
                    ? body.tags[0]
                    : (body.title || '')

                Workflows.jobs[trimmedJobId] = {
                    endpoint: endpoint,
                    payload: payload, // Extracted from API response
                    name: jobName,
                    status: status,
                    startedAt: body.created ? new Date(body.created).getTime() : Date.now(),
                    fromServer: true,
                    body: body
                }

                console.log('[MapJobSubmitTool] Created job with name:', jobName, 'and payload:', payload)

                // Add to ordered list at the top
                const i = Workflows.jobIds.indexOf(trimmedJobId)
                if (i !== -1) Workflows.jobIds.splice(i, 1)
                Workflows.jobIds.unshift(trimmedJobId)
                Workflows.page = 0

                // Save to database
                return recordSubmittedJob(trimmedJobId, endpoint, payload, jobName)
                    .then(() => {
                        window.alert('Job imported successfully!')
                        Workflows.ensurePolling()
                        Workflows.renderJobs()
                    })
                    .catch((err) => {
                        console.warn('[MapJobSubmitTool] Failed to save imported job to DB:', err)
                        // Still show the job even if DB save fails
                        window.alert('Job imported successfully! (Note: failed to persist to database)')
                        Workflows.ensurePolling()
                        Workflows.renderJobs()
                    })
            })
            .catch((err) => {
                console.error('[MapJobSubmitTool] Failed to import job:', err)
                // Parse error message to show more specific feedback
                const errMsg = err.message || String(err)
                if (errMsg.includes('404')) {
                    window.alert('Job not found. The Job ID does not exist or you do not have permission to view it.')
                } else if (errMsg.includes('403')) {
                    window.alert('Access denied. Please check your authentication token.')
                } else if (errMsg.includes('401')) {
                    window.alert('Unauthorized. Please connect with a valid personal access token.')
                } else {
                    window.alert(`Failed to import job: ${errMsg}`)
                }
            })
            .finally(() => {
                $btn.attr('disabled', false).text('Import Job')
            })
    })

    // Click-to-expand on job rows. Delegated so it survives re-renders.
    $root.find('.mjs-jobs-list').on('click', '.mjs-job-header', function () {
        const id = $(this).attr('data-job-id')
        if (!id) return

        // If collapsing, clear any map inputs being displayed
        if (Workflows.expandedIds.has(id)) {
            Workflows.expandedIds.delete(id)
            MapInputDisplay.clear(id)
        } else {
            Workflows.expandedIds.add(id)
        }

        Workflows.renderJobs()
    })

    // Add a completed job's STAC/vector output as a map layer. Delegated.
    $root.find('.mjs-jobs-list').on('click', '.mjs-layer-add', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const job = Workflows.jobs[id]
        if (!job || !job.autoAddableUri || job.layerAdded) return
        $(this).text('Adding…').attr('disabled', true)
        addLayerForJob(id, job)
    })

    // Remove a run's layer (map + registries + stored config). Delegated.
    $root.find('.mjs-jobs-list').on('click', '.mjs-layer-remove', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const job = Workflows.jobs[id]
        if (!job) return
        if (
            !window.confirm(
                'Remove this layer from the map and the mission configuration?'
            )
        )
            return
        removeLayerForJob(id, job)
    })

    // Toggle layer visibility for a completed job's output. Delegated.
    $root.find('.mjs-jobs-list').on('click', '.mjs-layer-toggle', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const layerObj = L_.layers.data[id]
        if (!layerObj) return
        Promise.resolve(L_.toggleLayer(layerObj)).then(() =>
            Workflows.renderJobs()
        )
    })

    // View job inputs on map (lat/lon/bbox). Delegated.
    $root.find('.mjs-jobs-list').on('click', '.mjs-view-inputs-btn', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const job = Workflows.jobs[id]
        if (!job || !job.payload) return

        // Toggle: if already showing, clear; otherwise show
        if (MapInputDisplay.layers[id] && MapInputDisplay.layers[id].length > 0) {
            MapInputDisplay.clear(id)
        } else {
            MapInputDisplay.show(id, job.payload)
        }

        // Re-render to update button text
        Workflows.renderJobs()
    })

    // Remove job from MMGIS database (not from MAAP). Delegated.
    $root.find('.mjs-jobs-list').on('click', '.mjs-remove-job-btn', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return

        if (!window.confirm('This will delete the job from this MMGIS instance, not your MAAP account. You can readd this job later with the Import Job button.')) {
            return
        }

        const $btn = $(this)
        $btn.attr('disabled', true).text('Removing...')

        // Delete from database
        deleteJobFromDatabase(id)
            .then(() => {
                // Remove from local state
                delete Workflows.jobs[id]
                const idx = Workflows.jobIds.indexOf(id)
                if (idx !== -1) {
                    Workflows.jobIds.splice(idx, 1)
                }

                // Clear any map displays
                MapInputDisplay.clear(id)

                // Remove layer if it exists
                if (L_.layers.data[id]) {
                    const job = { layerAdded: true }
                    removeLayerForJob(id, job).then(() => {
                        Workflows.renderJobs()
                    })
                } else {
                    Workflows.renderJobs()
                }
            })
            .catch((err) => {
                console.error('[MapJobSubmitTool] Failed to remove job:', err)
                window.alert(`Failed to remove job: ${err.message}`)
                $btn.attr('disabled', false).text('Remove Job')
            })
    })

    // Handle "Select Point on Map" button for lat/lon pairs. Delegated.
    $root.on('click', '.mjs-select-point-btn', function(e) {
        e.preventDefault()
        e.stopPropagation()

        // If already active, cancel the selection
        if ($(this).hasClass('mjs-map-select-active')) {
            MapSelection.cancel()
            return
        }

        const latKey = $(this).attr('data-lat-key')
        const lonKey = $(this).attr('data-lon-key')
        if (!latKey || !lonKey) return

        // Find the input fields for lat and lon
        const $latInput = $(`#mjs-input-${latKey.replace(/[^A-Za-z0-9_-]/g, '_')}`)
        const $lonInput = $(`#mjs-input-${lonKey.replace(/[^A-Za-z0-9_-]/g, '_')}`)

        if (!$latInput.length || !$lonInput.length) return

        // Start point selection with both inputs
        MapSelection.startPoint(latKey, lonKey, $latInput, $lonInput)

        // Update button text to indicate active selection
        $(this).text('Click map to select point').addClass('mjs-map-select-active')

        // Restore button text when selection is cancelled/completed
        const originalBtn = $(this)
        const restoreBtn = () => {
            originalBtn.text('Select Point on Map').removeClass('mjs-map-select-active')
        }

        // Poll to detect when selection is cancelled
        const checkInterval = setInterval(() => {
            if (!MapSelection.active) {
                restoreBtn()
                clearInterval(checkInterval)
            }
        }, 100)
    })

    // Handle "Select on Map" button clicks for bbox/lat/lon inputs. Delegated.
    $root.on('click', '.mjs-map-select-btn', function(e) {
        e.preventDefault()
        e.stopPropagation()

        // If already active, cancel the selection
        if ($(this).hasClass('mjs-map-select-active')) {
            MapSelection.cancel()
            return
        }

        const inputKey = $(this).attr('data-input-key')
        if (!inputKey) return

        const selectType = getMapSelectType(inputKey)
        if (!selectType) return

        let $input = null
        let $bboxInputs = null

        if (selectType === 'bbox') {
            // Find the bbox input fields in the parent field
            const $field = $(this).closest('.mjs-field')
            const $minLon = $field.find('input[data-bbox-field="min_lon"]')
            const $minLat = $field.find('input[data-bbox-field="min_lat"]')
            const $maxLon = $field.find('input[data-bbox-field="max_lon"]')
            const $maxLat = $field.find('input[data-bbox-field="max_lat"]')

            if ($minLon.length && $minLat.length && $maxLon.length && $maxLat.length) {
                $bboxInputs = { $minLon, $minLat, $maxLon, $maxLat }
            }
        } else {
            // For point inputs, get the sibling input
            $input = $(this).siblings('input')
            if (!$input.length) return
        }

        MapSelection.start(selectType, inputKey, $input, $bboxInputs)

        // Update button text to indicate active selection
        $(this).text('Click to cancel').addClass('mjs-map-select-active')

        // Restore button text when selection is cancelled/completed
        const originalBtn = $(this)
        const restoreBtn = () => {
            originalBtn.text('Select on Map').removeClass('mjs-map-select-active')
        }

        // Poll to detect when selection is cancelled
        const checkInterval = setInterval(() => {
            if (!MapSelection.active) {
                restoreBtn()
                clearInterval(checkInterval)
            }
        }, 100)
    })

    let collectPayload = () => ({})

    function renderSelectedProcess() {
        if (!Workflows.selectedProcessID) {
            $('#mjs-endpoint-desc').text('')
            $form.empty().append('<div class="mjs-empty">Select an algorithm to see parameters.</div>')
            collectPayload = () => ({
                queue: $queueSelect.val() || '',
                tag: $tagInput.val().trim() || '',
                inputs: {}
            })
            return
        }

        // Show loading state
        $('#mjs-endpoint-desc').text('Loading...')
        $form.empty().append('<div class="mjs-empty">Loading parameters...</div>')

        // Fetch process details including inputs
        fetchProcessDetails(Workflows.selectedProcessID).then((details) => {
            if (!details) {
                $('#mjs-endpoint-desc').text('Failed to load process details')
                $form.empty().append('<div class="mjs-empty">Failed to load parameters.</div>')
                collectPayload = () => ({
                    queue: $queueSelect.val() || '',
                    tag: $tagInput.val().trim() || '',
                    inputs: {}
                })
                return
            }

            const desc = details.description || details.title || ''
            $('#mjs-endpoint-desc').text(desc)

            // Build form from the inputs object
            if (details.inputs && typeof details.inputs === 'object') {
                collectPayload = buildFormFromInputs($form, details.inputs, $queueSelect, $tagInput)
            } else {
                $form.empty().append('<div class="mjs-empty">No parameters required.</div>')
                collectPayload = () => ({
                    queue: $queueSelect.val() || '',
                    tag: $tagInput.val().trim() || '',
                    inputs: {}
                })
            }
        })
    }

    function populateAlgorithmDropdown() {
        const $select = $('#mjs-algorithm-select')
        $select.empty().append('<option value="">Select algorithm...</option>')
        if (PROCESSES.length === 0) {
            $select.attr('disabled', true)
            return
        }
        // Get unique algorithm ids
        const uniqueIds = Array.from(new Set(PROCESSES.map((p) => p.id)))
        uniqueIds.sort()
        uniqueIds.forEach((id) => {
            $select.append(`<option value="${escapeHTML(id)}">${escapeHTML(id)}</option>`)
        })
        $select.attr('disabled', false)
    }

    function populateVersionDropdown(algorithmId) {
        const $select = $('#mjs-version-select')
        $select.empty().append('<option value="">Select version...</option>')
        if (!algorithmId) {
            $select.attr('disabled', true)
            return
        }
        const matches = PROCESSES.filter((p) => p.id === algorithmId)
        const uniqueVersions = Array.from(new Set(matches.map((p) => p.version)))
        uniqueVersions.sort()
        uniqueVersions.forEach((v) => {
            $select.append(`<option value="${escapeHTML(v)}">${escapeHTML(v)}</option>`)
        })
        $select.attr('disabled', false)
    }

    function populateDeployerDropdown(algorithmId, version) {
        const $select = $('#mjs-deployer-select')
        $select.empty().append('<option value="">Select deployer...</option>')
        if (!algorithmId || !version) {
            $select.attr('disabled', true)
            return
        }
        const matches = PROCESSES.filter((p) => p.id === algorithmId && p.version === version)
        const uniqueDeployers = Array.from(new Set(matches.map((p) => p.deployedBy)))
        uniqueDeployers.sort()
        uniqueDeployers.forEach((d) => {
            const proc = matches.find((p) => p.deployedBy === d)
            const label = d || '(unknown)'
            $select.append(`<option value="${proc.processID}">${escapeHTML(label)}</option>`)
        })
        $select.attr('disabled', false)
    }

    function populateQueueDropdown() {
        const $select = $queueSelect
        const $queueSection = $select.parent()

        // Fetch resources from the API or config
        fetchResources().then((resources) => {
            // Mode 1: Queues disabled (resources is null)
            if (resources === null) {
                console.log('[MapJobSubmitTool] Queues disabled - hiding queue field')
                $queueSection.hide()
                return
            }

            // Mode 2 & 3: Show queue field
            $queueSection.show()
            $select.empty().append('<option value="">Select queue...</option>')

            if (!resources || resources.length === 0) {
                console.warn('[MapJobSubmitTool] No resources returned')
                $select.append('<option value="">No queues available</option>')
                $select.attr('disabled', false)
                return
            }

            // Handle both array of strings and array of objects
            if (Array.isArray(resources)) {
                resources.forEach((resource) => {
                    const value = typeof resource === 'string' ? resource : (resource.name || resource.id || String(resource))
                    const label = typeof resource === 'string' ? resource : (resource.label || resource.name || resource.id || String(resource))
                    $select.append(`<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`)
                })
            }

            $select.attr('disabled', false)
        }).catch((err) => {
            console.warn('[MapJobSubmitTool] Failed to load queues', err)
            $select.empty().append('<option value="">Failed to load queues</option>')
            $select.attr('disabled', false)
        })
    }

    function enableSubmit() {
        // Populate the algorithm dropdown now that we have PROCESSES
        populateAlgorithmDropdown()
        $submit.text('Submit Job').attr('disabled', false)
    }

    function renderUnauthenticated() {
        $authBanner.empty()
        const $section = $('<div class="mjs-auth-input-section"></div>')
        $section.append('<div class="mjs-section-label">Personal Access Token</div>')
        const $tokenInput = $(
            '<input type="password" id="mjs-token-input" placeholder="Paste your personal access token" autocomplete="off" />'
        )
        const $connectBtn = $(
            '<button type="button" class="mjs-connect-btn">Connect</button>'
        )

        $connectBtn.on('click', function () {
            const token = $tokenInput.val().trim()
            if (!token) {
                window.alert('Please enter a personal access token.')
                return
            }
            $connectBtn.text('Connecting...').attr('disabled', true)
            Workflows.connect(token)
        })

        // Allow Enter key to submit
        $tokenInput.on('keydown', function (e) {
            if (e.key === 'Enter') {
                $connectBtn.trigger('click')
            }
        })

        $section.append($tokenInput).append($connectBtn)
        $authBanner.append($section)

        // Add account creation link if configured
        if (Workflows.accountCreationUrl) {
            const $linkSection = $(
                `<div class="mjs-account-link">Link for information to create an account: <a href="${escapeHTML(
                    Workflows.accountCreationUrl
                )}" target="_blank" rel="noopener noreferrer">${escapeHTML(
                    Workflows.accountCreationUrl
                )}</a></div>`
            )
            $authBanner.append($linkSection)
        }

        // Hide form content (algorithms, parameters, submit button) until authenticated
        $('#mjs-form-content').hide()

        // Hide jobs section until authenticated
        $('.mjs-jobs').hide()
    }

    // Store render functions on Workflows object so connect() can call them
    Workflows._renderUnauthenticated = renderUnauthenticated
    Workflows._renderAuthenticated = renderAuthenticated
    Workflows._populateAlgorithmDropdown = populateAlgorithmDropdown

    function renderAuthenticated() {
        $authBanner.empty()

        const $row = $(
            `<div class="mjs-auth-ok">Connected · ${escapeHTML(
                Workflows.baseUrl
            )} <a class="mjs-signout" href="#">sign out</a></div>`
        )
        $row.find('.mjs-signout').on('click', function (e) {
            e.preventDefault()
            // Stop polling
            if (Workflows.pollTimer) {
                clearInterval(Workflows.pollTimer)
                Workflows.pollTimer = null
            }
            // Clear the token and user ID from memory
            Workflows.personalAccessToken = null
            Workflows.maapUserId = null
            // Clear jobs
            Workflows.jobs = {}
            Workflows.jobIds = []
            Workflows.lastRefreshTime = null
            // Hide jobs section and form content
            $('.mjs-jobs').hide()
            $('#mjs-form-content').hide()
            renderUnauthenticated()
        })

        $authBanner.append($row)

        // Show form content (algorithms, parameters, submit button) now that user is authenticated
        $('#mjs-form-content').show()

        // Populate algorithm dropdown (already fetched in make())
        populateAlgorithmDropdown()

        // Populate queue dropdown from MAAP API
        populateQueueDropdown()

        // Enable submit button
        $submit.text('Submit Job').attr('disabled', false)

        // Show jobs section now that user is authenticated
        $('.mjs-jobs').show()

        // Pull existing jobs for this MAAP user from the database
        console.log('[MapJobSubmitTool] Loading jobs for MAAP user:', Workflows.maapUserId)
        Workflows.refreshFromServer()
    }

    // Cascade: algorithm → version → deployer → processID
    $('#mjs-algorithm-select').on('change', function () {
        Workflows.selectedAlgorithmId = $(this).val()
        Workflows.selectedVersion = null
        Workflows.selectedDeployer = null
        Workflows.selectedProcessID = null
        $('#mjs-version-select').val('').attr('disabled', true)
        $('#mjs-deployer-select').val('').attr('disabled', true)
        if (Workflows.selectedAlgorithmId) {
            populateVersionDropdown(Workflows.selectedAlgorithmId)
        }
        // Clear map selections when algorithm changes
        MapSelection.clearPersistentLayers()
        renderSelectedProcess()
    })

    $('#mjs-version-select').on('change', function () {
        Workflows.selectedVersion = $(this).val()
        Workflows.selectedDeployer = null
        Workflows.selectedProcessID = null
        $('#mjs-deployer-select').val('').attr('disabled', true)
        if (Workflows.selectedAlgorithmId && Workflows.selectedVersion) {
            populateDeployerDropdown(Workflows.selectedAlgorithmId, Workflows.selectedVersion)
        }
        // Clear map selections when version changes
        MapSelection.clearPersistentLayers()
        renderSelectedProcess()
    })

    $('#mjs-deployer-select').on('change', function () {
        const processID = parseInt($(this).val(), 10)
        if (isNaN(processID)) {
            Workflows.selectedProcessID = null
            Workflows.selectedDeployer = null
        } else {
            Workflows.selectedProcessID = processID
            const proc = PROCESSES.find((p) => p.processID === processID)
            Workflows.selectedDeployer = proc ? proc.deployedBy : null
        }
        // Clear map selections when deployer changes
        MapSelection.clearPersistentLayers()
        renderSelectedProcess()
    })

    $submit.on('click', function () {
        // Check authentication first
        if (!Workflows.personalAccessToken) {
            window.alert('Please enter your personal access token to connect before submitting a job.')
            return
        }

        // Then check if algorithm is selected
        if (!Workflows.selectedProcessID) {
            window.alert('Please select an algorithm, version, and deployer.')
            return
        }

        // Only validate queue if the queue section is visible (queues enabled)
        const $queueSection = $('.mjs-queue-section')
        if ($queueSection.is(':visible')) {
            const queue = $queueSelect.val()
            if (!queue) {
                window.alert('Please select a queue.')
                $queueSelect.trigger('focus')
                return
            }
        }

        // Sanitize tag/name input to prevent XSS
        const tag = sanitizeInput($tagInput.val().trim())
        const payload = collectPayload()

        // Remove queue from payload if queues are disabled
        if (!$queueSection.is(':visible') && payload.queue !== undefined) {
            delete payload.queue
        }

        $submit.attr('disabled', true).text('Submitting…')
        Workflows.submit(Workflows.selectedProcessID, payload, tag)
            .then(() => {
                $submit.attr('disabled', false).text('Submit Job')
                $tagInput.val('')
                // Clear any persistent map selections (bbox rectangles, point markers)
                MapSelection.clearPersistentLayers()
            })
            .catch((err) => {
                $submit.attr('disabled', false).text('Submit Job')
                console.error('[MapJobSubmitTool] Submit error:', err)
                // Display error message to user
                const errorMsg = err.message || 'Unknown error occurred'
                window.alert(`Job Submission Failed\n\n${errorMsg}`)
            })
    })

    if (!Workflows.baseUrl) {
        $authBanner.append(
            '<div class="mjs-auth-msg">No API Base URL configured. Set it in the Configure page under Tools → Workflows.</div>'
        )
        $submit.text('Not configured').attr('disabled', true)
    } else {
        // Show the token input form immediately
        renderUnauthenticated()
        // Populate algorithm dropdown if processes are already loaded
        populateAlgorithmDropdown()
    }

    this.separateFromMMGIS = function () {}
}

const MapJobSubmit = Workflows
export default MapJobSubmit
