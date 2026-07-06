import $ from 'jquery'
import './WorkflowsTool.css'
import L_ from '../../Basics/Layers_/Layers_'
import ToolController_ from '../../Basics/ToolController_/ToolController_'

// mmgisAPI is intentionally accessed via window.mmgisAPI at call time rather
// than imported at module top. Importing it here creates a cycle through
// src/pre/tools.js → WorkflowsTool → mmgisAPI → LayerUtils that fails with
// "Cannot access '__WEBPACK_DEFAULT_EXPORT__' before initialization."

const VECTOR_EXTS = ['geojson', 'json', 'gpkg', 'kml']
const DEFAULT_POLL_INTERVAL_MS = 30000
const AUTH_POLL_INTERVAL_MS = 2000
const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000
const SUBMITTED_STORAGE_KEY = 'mmgis.workflows.submitted'
const SUBMITTED_MAX_ENTRIES = 100
const PAGE_SIZE = 10

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
    return fetch(mmgisUrl(path), {
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            ...((init && init.headers) || {}),
        },
        ...(init || {}),
    })
}

// Returns { [workflow_id]: { endpoint, payload, name, ts } }
function fetchSubmittedRegistry() {
    return mmgisFetch('api/workflows-history')
        .then((r) => r.json())
        .then((d) => {
            if (!d || d.status !== 'success' || !Array.isArray(d.body))
                return {}
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
            return out
        })
        .catch(() => ({}))
}

function recordSubmittedJob(jobId, endpoint, payload, name) {
    return mmgisFetch('api/workflows-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            workflow_id: jobId,
            endpoint,
            payload,
            name: name || '',
        }),
    }).catch(() => {})
}

function updateJobName(jobId, name) {
    return mmgisFetch('api/workflows-history/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_id: jobId, name: name || '' }),
    }).catch(() => {})
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
    const entries = Object.entries(parsed).filter(
        ([id]) => !id.startsWith('mock-')
    )
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

// Hardcoded from the cmss_api OpenAPI spec. When the upstream API gains or
// changes endpoints, edit this array. Field shape:
//   { name, type: 'string'|'number'|'boolean'|'date', default?, min?, max?,
//     description?, hidden?, readOnly? }
// hidden: don't render the field; always send its default in the payload.
// readOnly: render the field disabled (so the user sees the value) and always
// send its default in the payload.
//
// TEMPORARY: fields whose value is a file:// URI are also stripped from every
// display surface (form, params summary, expanded JSON) and always sent as
// their default. file:// values point at server-local paths that aren't
// meaningful to the end user. Remove the isFilePathValue treatment below
// when the API stops requiring these in the request payload, or when we
// teach the UI to surface them helpfully.
const ENDPOINTS = [
    {
        path: '/api/nfss/flood_prediction_inference',
        label: 'Flood Prediction Inference',
        category: 'Forecasting',
        description: 'Enqueue flood prediction inference.',
        fields: [
            {
                name: 'forecast_date',
                type: 'date',
                default: '2016-09-15',
            },
            {
                name: 'precipitation_scale_factor',
                type: 'string',
                default: '1.0',
            },
        ],
    },
    {
        path: '/api/iass/aquaculture_impact_assessment',
        label: 'Aquaculture Impact Assessment',
        category: 'Assessment',
        description: 'Enqueue aquaculture impact assessment.',
        fields: [
            {
                name: 'aquaculture_data_uri',
                type: 'string',
                default: 'file:///app/iass/data/czdt_shellfish.gpkg',
                description:
                    'URI of the aquaculture shape dataset (file readable by GeoPandas).',
            },
            {
                name: 'geophysical_data_uri',
                type: 'string',
                default:
                    'file:///app/iass/data/czdt_chesroms_ECB_HR_avg_20250806.nc',
                description:
                    'URI of the gridded geophysical dataset (XArray-readable).',
            },
            {
                name: 'geophysical_data_variable',
                type: 'string',
                default: 'temp',
            },
            {
                name: 'threshold',
                type: 'number',
                default: 90,
                description:
                    'Mean geophysical threshold that identifies impacted aquaculture.',
            },
            {
                name: 'impact_exceeds_threshold',
                type: 'boolean',
                default: true,
            },
            {
                name: 'output_file_suffix',
                type: 'string',
                default: 'gpkg',
            },
        ],
    },
    {
        path: '/api/iass/flood_population_impact_assessment',
        label: 'Population Impact Assessment',
        category: 'Assessment',
        description: 'Enqueue population impact assessment.',
        fields: [
            {
                name: 'population_data_uri',
                type: 'string',
                default:
                    'file:///app/iass/data/czdt_gpw_v4_population_density_rev11_2020_30_sec_2020.nc',
            },
            {
                name: 'population_data_variable',
                type: 'string',
                default: 'population',
            },
            {
                name: 'geophysical_data_uri',
                type: 'string',
                default: 'file:///app/iass/data/LIS_HIST_202001010000_remap.d01.nc',
            },
            {
                name: 'geophysical_data_variable',
                type: 'string',
                default: 'FloodedFrac_tavg',
            },
            {
                name: 'threshold',
                type: 'number',
                default: 0.15,
                min: 0,
                max: 1,
            },
            {
                name: 'impact_exceeds_threshold',
                type: 'boolean',
                default: true,
            },
            {
                name: 'output_file_suffix',
                type: 'string',
                default: 'zarr',
            },
            {
                name: 'aggregation_units_uri',
                type: 'string',
                default: 'file:///app/iass/data/czdt_tl_2024_us_county.gpkg',
            },
            {
                name: 'aggregation_output_file_suffix',
                type: 'string',
                default: 'gpkg',
            },
        ],
    },
]

function escapeHTML(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function normalizeStatus(s) {
    if (!s || typeof s !== 'string') return ''
    return s.toLowerCase()
}

function isTerminal(status) {
    const s = normalizeStatus(status)
    return s === 'completed' || s === 'failed' || s === 'cancelled'
}

// TEMPORARY: see comment on the ENDPOINTS const above.
function isFilePathValue(v) {
    return typeof v === 'string' && v.startsWith('file://')
}

// Pull a status from either our mock shape (job_status) or the real workflow
// shape (workflow_status). Always returned lowercase to keep CSS classes
// consistent.
function readStatus(body) {
    return normalizeStatus(
        (body && (body.workflow_status || body.job_status)) || ''
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

function trimSlash(u) {
    return (u || '').replace(/\/+$/, '')
}

function buildForm($parent, fields) {
    $parent.empty()
    if (!fields || fields.length === 0) {
        $parent.append('<div class="wf-empty">No parameters.</div>')
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
        const id = `wf-field-${f.name.replace(/[^A-Za-z0-9_-]/g, '_')}`
        const initial = f.default
        const initialStr = initial != null ? String(initial) : ''
        const $field = $('<div class="wf-field"></div>')
        const lockedSuffix = f.readOnly
            ? ' <span class="wf-field-locked">read-only</span>'
            : ''
        $field.append(
            `<div class="wf-field-label"><label for="${id}">${escapeHTML(
                f.name
            )}</label><span class="wf-field-type">${escapeHTML(
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
            $input.prop('disabled', true).addClass('wf-input-readonly')
        }
        $field.append($input)
        if (f.description) {
            $field.append(
                `<div class="wf-field-description">${escapeHTML(
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
            '<div class="wf-empty">All parameters hidden; defaults will be sent.</div>'
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
                v = $input.val()
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

const GROUP_UUID = 'workflows-tool-group'
const GROUP_DISPLAY_NAME = 'Workflow Outputs'

// Get (or lazily create + register) the header group all workflow layers
// live under in the Layers panel. The same object reference is shared
// between L_.configData.layers and L_.layers.data, mirroring parseConfig.
function ensureWorkflowsGroup() {
    if (L_.layers.data[GROUP_UUID]) return L_.layers.data[GROUP_UUID]
    const header = {
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
    const uuid = `workflow-${jobId}`
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

function addLayerForJob(jobId, job) {
    const uri = job.autoAddableUri
    if (!uri) return
    const uuid = `workflow-${jobId}`
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
            Workflows.renderJobs()
        } catch (err) {
            console.warn('[WorkflowsTool] addLayer failed', err)
        }
    })()
}

// ---- HTTP helpers ----

function directFetchJSON(url, init) {
    return fetch(url, {
        credentials: 'include',
        ...(init || {}),
        headers: {
            Accept: 'application/json',
            ...((init && init.headers) || {}),
        },
    }).then(async (res) => {
        const text = await res.text()
        let json
        try {
            json = text ? JSON.parse(text) : {}
        } catch (e) {
            json = { raw: text }
        }
        return { ok: res.ok, status: res.status, body: json }
    })
}

function checkAuth() {
    return directFetchJSON(
        trimSlash(Workflows.baseUrl) + '/api/auth-status'
    )
        .then((r) => {
            if (!r.ok) return false
            if (
                r.body &&
                (r.body.authenticated === false ||
                    r.body.status === 'unauthenticated')
            )
                return false
            return true
        })
        .catch(() => false)
}

function submitJob(endpointPath, payload) {
    return directFetchJSON(trimSlash(Workflows.baseUrl) + endpointPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
    }).then((r) => {
        if (!r.ok) {
            const msg =
                (r.body && (r.body.detail || r.body.message)) ||
                `Submit ${r.status}`
            throw new Error(
                typeof msg === 'string' ? msg : JSON.stringify(msg)
            )
        }
        return r.body || {}
    })
}

function pollJob(jobId) {
    return directFetchJSON(
        trimSlash(Workflows.baseUrl) +
            '/api/workflows/' +
            encodeURIComponent(jobId)
    ).then((r) => (r.ok ? r.body || {} : {}))
}

function listJobIds() {
    return directFetchJSON(
        trimSlash(Workflows.baseUrl) + '/api/workflows/all_ids'
    ).then((r) => (r.ok && Array.isArray(r.body) ? r.body : []))
}

// ---- Tool ----

const Workflows = {
    height: 0,
    width: 360,
    vars: null,
    baseUrl: '',
    selectedEndpointPath: null,
    jobs: {},
    jobIds: [],
    expandedIds: null, // initialized in make()
    paramsExpandedIds: null, // initialized in make()
    page: 0,
    pollTimer: null,
    authPollTimer: null,
    onAuthReady: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    MMGISInterface: null,

    make: function () {
        Workflows.vars = L_.getToolVars('workflows') || {}
        if (Workflows.vars.pollIntervalMs)
            Workflows.pollIntervalMs = Workflows.vars.pollIntervalMs
        // baseUrl is a tool variable (configurable in the Configure UI).
        // Fall back to the legacy top-level `workflows` config block for
        // missions configured before this moved.
        const legacy = (L_.configData && L_.configData.workflows) || {}
        Workflows.baseUrl = Workflows.vars.baseUrl || legacy.baseUrl || ''
        if (!Workflows.expandedIds) Workflows.expandedIds = new Set()
        if (!Workflows.paramsExpandedIds)
            Workflows.paramsExpandedIds = new Set()
        Workflows.MMGISInterface = new interfaceWithMMGIS()
        // Hydrate the per-user submitted-job registry asynchronously from
        // the MMGIS DB. UI renders immediately with whatever in-memory state
        // we have; rows refresh once the fetch returns. Legacy localStorage
        // data (from before this was moved server-side) gets one-time
        // migrated first.
        migrateLegacyLocalStorageRegistry()
            .then(fetchSubmittedRegistry)
            .then((reg) => {
                Object.keys(reg).forEach((jobId) => {
                    if (jobId.startsWith('mock-')) return
                    if (!Workflows.jobs[jobId]) {
                        Workflows.jobs[jobId] = {
                            endpoint: reg[jobId].endpoint || '',
                            payload: reg[jobId].payload,
                            name: reg[jobId].name || '',
                            status: 'unknown',
                            startedAt: reg[jobId].ts || Date.now(),
                        }
                    } else {
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
                Workflows.renderJobs()
            })
    },

    destroy: function () {
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
    },

    // Opens the workflows API's OAuth login in a popup, then polls
    // auth-status until the session cookie lands (or times out).
    connect: function () {
        const popup = window.open(
            trimSlash(Workflows.baseUrl) + '/api/login',
            'wf_login',
            'width=520,height=720,resizable,scrollbars'
        )
        if (!popup) {
            window.alert(
                'Popup blocked. Allow popups for this site and click Connect again.'
            )
            return
        }
        Workflows.startAuthPoll()
    },

    startAuthPoll: function () {
        if (Workflows.authPollTimer) return
        const startedAt = Date.now()
        Workflows.authPollTimer = setInterval(() => {
            if (Date.now() - startedAt > AUTH_POLL_TIMEOUT_MS) {
                clearInterval(Workflows.authPollTimer)
                Workflows.authPollTimer = null
                return
            }
            checkAuth().then((ok) => {
                if (!ok) return
                clearInterval(Workflows.authPollTimer)
                Workflows.authPollTimer = null
                if (typeof Workflows.onAuthReady === 'function')
                    Workflows.onAuthReady()
            })
        }, AUTH_POLL_INTERVAL_MS)
    },

    submit: function (endpointPath, payload, name) {
        return submitJob(endpointPath, payload).then((body) => {
            const jobId = body.job_id || body._id
            if (!jobId) throw new Error('No job_id in response')
            Workflows.jobs[jobId] = {
                endpoint: endpointPath,
                payload: payload,
                name: name || '',
                status: readStatus(body) || 'queued',
                startedAt: Date.now(),
            }
            recordSubmittedJob(jobId, endpointPath, payload, name)
            // Prepend to ordered list and jump to first page so the user
            // sees their submission immediately.
            const i = Workflows.jobIds.indexOf(jobId)
            if (i !== -1) Workflows.jobIds.splice(i, 1)
            Workflows.jobIds.unshift(jobId)
            Workflows.page = 0
            Workflows.ensurePolling()
            Workflows.renderJobs()
            return jobId
        })
    },

    ensurePolling: function () {
        if (Workflows.pollTimer) return
        Workflows.pollTimer = setInterval(
            Workflows.pollAll,
            Workflows.pollIntervalMs
        )
    },

    refreshFromServer: function () {
        return listJobIds()
            .then((ids) => {
                const serverIds = Array.isArray(ids) ? ids.slice() : []
                // Assume server returns oldest-first; show newest-first.
                serverIds.reverse()
                const serverSet = new Set(serverIds)
                // Local-only ids first (sorted newest-first by our timestamp)
                // so freshly submitted jobs stay visible even before the
                // server has them indexed.
                const localOnly = Object.keys(Workflows.jobs)
                    .filter((id) => !serverSet.has(id))
                    .sort(
                        (a, b) =>
                            (Workflows.jobs[b].startedAt || 0) -
                            (Workflows.jobs[a].startedAt || 0)
                    )
                Workflows.jobIds = localOnly.concat(serverIds)
                // Clamp the current page in case the new list is shorter.
                const maxPage = Math.max(
                    0,
                    Math.ceil(Workflows.jobIds.length / PAGE_SIZE) - 1
                )
                if (Workflows.page > maxPage) Workflows.page = maxPage
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
                console.warn('[WorkflowsTool] refresh failed', err)
            })
    },

    fetchPageDetails: function () {
        const start = Workflows.page * PAGE_SIZE
        const slice = Workflows.jobIds.slice(start, start + PAGE_SIZE)
        return Promise.all(
            slice.map((id) =>
                pollJob(id).then((body) => mergeJobUpdate(id, body))
            )
        )
    },

    goToPage: function (n) {
        const maxPage = Math.max(
            0,
            Math.ceil(Workflows.jobIds.length / PAGE_SIZE) - 1
        )
        const target = Math.max(0, Math.min(n, maxPage))
        if (target === Workflows.page) return
        Workflows.page = target
        Workflows.fetchPageDetails().then(() => Workflows.renderJobs())
        Workflows.renderJobs() // immediate render with whatever we have
    },

    pollAll: function () {
        const ids = Object.keys(Workflows.jobs).filter(
            (id) => !isTerminal(Workflows.jobs[id].status)
        )
        if (ids.length === 0) {
            clearInterval(Workflows.pollTimer)
            Workflows.pollTimer = null
            return
        }
        ids.forEach((id) => {
            pollJob(id).then((body) => {
                const prev = Workflows.jobs[id]
                if (!prev) return
                const prevStatus = prev.status
                mergeJobUpdate(id, body)
                if (Workflows.jobs[id].status !== prevStatus)
                    Workflows.renderJobs()
            })
        })
    },

    renderJobs: function () {
        const $list = $('#workflowsTool .wf-jobs-list')
        if ($list.length === 0) return
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

        const total = Workflows.jobIds.length
        if (total === 0) {
            $list.append('<div class="wf-empty">No jobs yet.</div>')
            renderPagination(0, 0, 0)
            return
        }

        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
        if (Workflows.page >= totalPages) Workflows.page = totalPages - 1
        const start = Workflows.page * PAGE_SIZE
        const pageIds = Workflows.jobIds.slice(start, start + PAGE_SIZE)

        pageIds.forEach((id) => {
            const job = Workflows.jobs[id] || { status: 'loading…', endpoint: '' }
            const statusClass = normalizeStatus(job.status) || 'loading'
            const isExpanded = Workflows.expandedIds.has(id)
            const $div = $('<div class="wf-job"></div>')
            const primary = job.name
                ? `<span class="wf-job-name">${escapeHTML(job.name)}</span> ` +
                  `<span class="wf-job-id-mini">${escapeHTML(id)}</span>`
                : `<span class="wf-job-id">${escapeHTML(id)}</span>`
            const $header = $(
                `<div class="wf-job-header" data-job-id="${escapeHTML(id)}">` +
                    `<span class="wf-job-chevron">${isExpanded ? '▼' : '▶'}</span> ` +
                    primary + ' ' +
                    `<span class="wf-job-status ${escapeHTML(statusClass)}">${escapeHTML(job.status)}</span>` +
                    `</div>`
            )
            $div.append($header)
            if (job.endpoint) {
                $div.append(
                    `<div class="wf-job-output">${escapeHTML(job.endpoint)}</div>`
                )
            }
            if (job.payload && Object.keys(job.payload).length > 0) {
                // TEMPORARY: file:// values are stripped from display (still
                // sent to the API — see comment on ENDPOINTS).
                const displayEntries = Object.entries(job.payload).filter(
                    ([, v]) => !isFilePathValue(v)
                )
                if (displayEntries.length > 0) {
                    const paramsOpen = Workflows.paramsExpandedIds.has(id)
                    $div.append(
                        `<div class="wf-params-toggle" data-job-id="${escapeHTML(
                            id
                        )}">${paramsOpen ? '▼' : '▶'} parameters (${
                            displayEntries.length
                        })</div>`
                    )
                    if (paramsOpen) {
                        const $params = $('<div class="wf-job-params"></div>')
                        displayEntries.forEach(([k, v]) => {
                            $params.append(
                                `<span class="wf-param-key">${escapeHTML(k)}</span>`
                            )
                            $params.append(
                                `<span class="wf-param-val" title="${escapeHTML(
                                    String(v == null ? '' : v)
                                )}">${escapeHTML(formatParamValue(v))}</span>`
                            )
                        })
                        $div.append($params)
                    }
                }
            }
            if (statusClass === 'running' && job.currentStage) {
                $div.append(
                    `<div class="wf-job-stage">stage: ${escapeHTML(
                        job.currentStage
                    )}</div>`
                )
            }
            if (statusClass === 'failed' && job.error) {
                $div.append(
                    `<div class="wf-job-error">${escapeHTML(job.error)}</div>`
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

function buildExpandedSection(job, jobId) {
    const $exp = $('<div class="wf-job-expanded"></div>')

    // Name — editable. Locally-stored (the API has no concept of job names).
    $exp.append('<div class="wf-exp-label">Name</div>')
    const $nameRow = $('<div class="wf-exp-name-row"></div>')
    const $nameInput = $(
        `<input type="text" class="wf-exp-name-input" placeholder="e.g. SF Sept-15 forecast" value="${escapeHTML(
            job.name || ''
        )}" />`
    )
    const $nameSave = $(
        '<button type="button" class="wf-exp-name-save">Save</button>'
    )
    $nameSave.on('click', function () {
        const newName = $nameInput.val().trim()
        if (job) job.name = newName
        updateJobName(jobId, newName)
        Workflows.renderJobs()
    })
    $nameInput.on('keydown', function (e) {
        if (e.key === 'Enter') $nameSave.trigger('click')
    })
    $nameRow.append($nameInput).append($nameSave)
    $exp.append($nameRow)

    // Submitted params — only if we know them (locally submitted or hydrated
    // from the persistent registry). TEMPORARY: file:// values stripped.
    if (job.payload && Object.keys(job.payload).length > 0) {
        const display = Object.fromEntries(
            Object.entries(job.payload).filter(
                ([, v]) => !isFilePathValue(v)
            )
        )
        if (Object.keys(display).length > 0) {
            $exp.append('<div class="wf-exp-label">Submitted parameters</div>')
            const $pre = $('<pre class="wf-exp-json"></pre>')
            $pre.text(JSON.stringify(display, null, 2))
            $exp.append($pre)
        }
    } else if (job.fromServer) {
        $exp.append(
            '<div class="wf-exp-hint">No submitted parameters on record (job was likely submitted from elsewhere or before this browser stored them).</div>'
        )
    }

    // Outputs list, plus a single "Add to map" button that adds the run's
    // STAC item (or best other loadable output) as a layer.
    if (Array.isArray(job.output_uris) && job.output_uris.length > 0) {
        const statusClass = normalizeStatus(job.status)
        const visible = L_.layers.on[`workflow-${jobId}`] === true
        $exp.append(
            `<div class="wf-exp-label">Outputs (${job.output_uris.length})</div>`
        )
        const $outs = $('<div class="wf-job-outputs"></div>')
        job.output_uris.forEach((u) => {
            $outs.append(
                `<div class="wf-job-output-line" title="${escapeHTML(
                    u
                )}">→ ${escapeHTML(formatParamValue(u))}</div>`
            )
        })
        $exp.append($outs)

        if (statusClass === 'completed' && job.autoAddableUri) {
            // Two explicit controls: "Add layer" (one-time) and a visibility
            // toggle that's only live once the layer exists on the map.
            const $row = $('<div class="wf-map-btn-row"></div>')
            $row.append(
                `<button type="button" class="wf-map-btn wf-layer-add" data-job-id="${escapeHTML(
                    jobId
                )}"${job.layerAdded ? ' disabled' : ''}>${
                    job.layerAdded ? 'Layer added' : 'Add layer'
                }</button>`
            )
            $row.append(
                `<button type="button" class="wf-map-btn wf-layer-toggle" data-job-id="${escapeHTML(
                    jobId
                )}"${!job.layerAdded ? ' disabled' : ''}>${
                    job.layerAdded
                        ? visible
                            ? 'Hide layer'
                            : 'Show layer'
                        : 'Show/Hide'
                }</button>`
            )
            $exp.append($row)
        }
    }

    // Server-side metadata, when present.
    const body = job.body
    if (body) {
        if (body.created_at || body.updated_at) {
            $exp.append('<div class="wf-exp-label">Timing</div>')
            const lines = []
            if (body.created_at)
                lines.push(`created: ${formatLocale(body.created_at)}`)
            if (body.updated_at)
                lines.push(`updated: ${formatLocale(body.updated_at)}`)
            $exp.append(
                `<div class="wf-exp-hint">${escapeHTML(lines.join(' · '))}</div>`
            )
        }
        if (Array.isArray(body.stages) && body.stages.length > 0) {
            $exp.append('<div class="wf-exp-label">Stages</div>')
            const $stages = $('<div class="wf-exp-stages"></div>')
            body.stages.forEach((s, i) => {
                const sclass = normalizeStatus(s && s.status) || 'unknown'
                const isCurrent = i === body.current_stage_index
                const $row = $(
                    `<div class="wf-exp-stage ${escapeHTML(sclass)}${
                        isCurrent ? ' current' : ''
                    }">` +
                        `<span class="wf-exp-stage-status">${escapeHTML(
                            s.status || ''
                        )}</span> ` +
                        `<span class="wf-exp-stage-name">${escapeHTML(
                            s.name || ''
                        )}</span>` +
                        (s.subsystem
                            ? ` <span class="wf-exp-stage-sub">[${escapeHTML(
                                  s.subsystem
                              )}]</span>`
                            : '') +
                        `</div>`
                )
                if (s.error_message) {
                    $row.append(
                        `<div class="wf-exp-stage-error">${escapeHTML(
                            s.error_message
                        )}</div>`
                    )
                }
                $stages.append($row)
            })
            $exp.append($stages)
        }
    }

    return $exp
}

function renderPagination(page, totalPages, total) {
    const $container = $('#workflowsTool .wf-pagination')
    if ($container.length === 0) return
    $container.empty()
    if (totalPages <= 1) return
    const $prev = $(
        '<button type="button" class="wf-page-btn wf-page-prev">Prev</button>'
    )
    if (page === 0) $prev.attr('disabled', true)
    $prev.on('click', () => Workflows.goToPage(Workflows.page - 1))
    const $next = $(
        '<button type="button" class="wf-page-btn wf-page-next">Next</button>'
    )
    if (page >= totalPages - 1) $next.attr('disabled', true)
    $next.on('click', () => Workflows.goToPage(Workflows.page + 1))
    const $label = $(
        `<span class="wf-page-label">Page ${page + 1} of ${totalPages} · ${total} jobs</span>`
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
    tools.html('<div id="workflowsTool" class="mmgisScrollbar"></div>')
    const $root = $('#workflowsTool')
    $root.append('<div class="wf-header">Workflows</div>')

    const $authBanner = $('<div id="wf-auth-banner"></div>')
    $root.append($authBanner)

    $root.append('<div class="wf-section-label">Endpoint</div>')
    const $endpointSelect = $('<select id="wf-endpoint-select"></select>')
    const byCategory = ENDPOINTS.reduce((acc, ep) => {
        const cat = ep.category || 'Other'
        ;(acc[cat] = acc[cat] || []).push(ep)
        return acc
    }, {})
    Object.keys(byCategory).forEach((cat) => {
        const $group = $(`<optgroup label="${escapeHTML(cat)}"></optgroup>`)
        byCategory[cat].forEach((ep) => {
            $group.append(
                `<option value="${escapeHTML(ep.path)}">${escapeHTML(
                    ep.label
                )}</option>`
            )
        })
        $endpointSelect.append($group)
    })
    $root.append($endpointSelect)
    $root.append('<div class="wf-endpoint-desc" id="wf-endpoint-desc"></div>')

    $root.append('<div class="wf-section-label">Run Name *</div>')
    const $nameInput = $(
        '<input type="text" id="wf-submit-name" class="wf-name-input" placeholder="e.g. SF Sept-15 forecast (required)" />'
    )
    $root.append($nameInput)

    $root.append('<div class="wf-section-label">Parameters</div>')
    const $form = $('<div id="wf-form"></div>')
    $root.append($form)

    const $submit = $('<button class="wf-submit" disabled>Loading…</button>')
    $root.append($submit)

    $root.append(
        '<div class="wf-jobs"><div class="wf-jobs-header"><div class="wf-section-label">Jobs</div><button class="wf-refresh-btn" type="button">Refresh</button></div><div class="wf-jobs-list"></div><div class="wf-pagination"></div></div>'
    )
    Workflows.renderJobs()

    $root.find('.wf-refresh-btn').on('click', function () {
        const $btn = $(this)
        $btn.attr('disabled', true).text('Refreshing…')
        Workflows.refreshFromServer().finally(() => {
            $btn.attr('disabled', false).text('Refresh')
        })
    })

    // Click-to-expand on job rows. Delegated so it survives re-renders.
    $root.find('.wf-jobs-list').on('click', '.wf-job-header', function () {
        const id = $(this).attr('data-job-id')
        if (!id) return
        if (Workflows.expandedIds.has(id)) Workflows.expandedIds.delete(id)
        else Workflows.expandedIds.add(id)
        Workflows.renderJobs()
    })

    // Toggle the inline params grid. Delegated.
    $root.find('.wf-jobs-list').on('click', '.wf-params-toggle', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        if (Workflows.paramsExpandedIds.has(id))
            Workflows.paramsExpandedIds.delete(id)
        else Workflows.paramsExpandedIds.add(id)
        Workflows.renderJobs()
    })

    // Add a completed job's STAC/vector output as a map layer. Delegated.
    $root.find('.wf-jobs-list').on('click', '.wf-layer-add', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const job = Workflows.jobs[id]
        if (!job || !job.autoAddableUri || job.layerAdded) return
        $(this).text('Adding…').attr('disabled', true)
        addLayerForJob(id, job)
    })

    // Toggle layer visibility for a completed job's output. Delegated.
    $root.find('.wf-jobs-list').on('click', '.wf-layer-toggle', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const layerObj = L_.layers.data[`workflow-${id}`]
        if (!layerObj) return
        Promise.resolve(L_.toggleLayer(layerObj)).then(() =>
            Workflows.renderJobs()
        )
    })

    let collectPayload = () => ({})

    function renderSelectedEndpoint() {
        const ep = ENDPOINTS.find(
            (e) => e.path === Workflows.selectedEndpointPath
        )
        if (!ep) return
        $('#wf-endpoint-desc').text(ep.description || ep.label)
        collectPayload = buildForm($form, ep.fields)
    }

    function enableSubmit() {
        Workflows.selectedEndpointPath = ENDPOINTS[0].path
        $endpointSelect.val(Workflows.selectedEndpointPath)
        renderSelectedEndpoint()
        $submit.text('Submit').attr('disabled', false)
    }

    function renderUnauthenticated() {
        $authBanner.empty()
        $authBanner.append(
            `<div class="wf-auth-msg">Not signed in to ${escapeHTML(
                Workflows.baseUrl
            )}.</div>`
        )
        const $btn = $('<button class="wf-connect-btn">Connect</button>')
        $btn.on('click', function () {
            $btn.attr('disabled', true).text('Waiting for sign-in…')
            Workflows.onAuthReady = function () {
                Workflows.onAuthReady = null
                renderAuthenticated()
            }
            Workflows.connect()
        })
        $authBanner.append($btn)
        $submit.text('Sign in to continue').attr('disabled', true)
    }

    function renderAuthenticated() {
        $authBanner.empty()
        const $row = $(
            `<div class="wf-auth-ok">Signed in · ${escapeHTML(
                Workflows.baseUrl
            )} <a class="wf-signout" href="#">sign out</a></div>`
        )
        $row.find('.wf-signout').on('click', function (e) {
            e.preventDefault()
            directFetchJSON(
                trimSlash(Workflows.baseUrl) + '/api/logout'
            ).finally(() => renderUnauthenticated())
        })
        $authBanner.append($row)
        enableSubmit()
        // Pull existing jobs from the server so the panel isn't empty on
        // first open of a new session.
        Workflows.refreshFromServer()
    }

    $endpointSelect.on('change', function () {
        Workflows.selectedEndpointPath = $(this).val()
        renderSelectedEndpoint()
    })

    $submit.on('click', function () {
        if (!Workflows.selectedEndpointPath) return
        const name = $nameInput.val().trim()
        if (!name) {
            window.alert('Please name this run before submitting.')
            $nameInput.trigger('focus')
            return
        }
        const payload = collectPayload()
        $submit.attr('disabled', true).text('Submitting…')
        Workflows.submit(Workflows.selectedEndpointPath, payload, name)
            .then(() => {
                $submit.attr('disabled', false).text('Submit')
                $nameInput.val('')
            })
            .catch((err) => {
                $submit.attr('disabled', false).text('Submit')
                window.alert(`Workflows submit failed: ${err.message}`)
            })
    })

    if (!Workflows.baseUrl) {
        $authBanner.append(
            '<div class="wf-auth-msg">No API Base URL configured. Set it in the Configure page under Tools → Workflows.</div>'
        )
        $submit.text('Not configured').attr('disabled', true)
    } else {
        $authBanner.append('<div class="wf-auth-msg">Checking sign-in…</div>')
        checkAuth().then((ok) => {
            if (ok) renderAuthenticated()
            else renderUnauthenticated()
        })
    }

    this.separateFromMMGIS = function () {}
}

export default Workflows
