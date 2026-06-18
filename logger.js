const fs = require("fs");
const path = require("path");

const LOGS_DIR = path.join(__dirname, "api_logs");
const PAYLOADS_DIR = path.join(LOGS_DIR, "full_payloads");

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);
if (!fs.existsSync(PAYLOADS_DIR)) fs.mkdirSync(PAYLOADS_DIR);

const LOG_FILE = path.join(LOGS_DIR, "api_interaction.log");

// Robust logging queue to handle file locks on network/virtual drives
const queue = [];
let processing = false;

function processQueue() {
	if (processing || queue.length === 0) return;
	processing = true;

	const entry = queue[0];

	try {
		let currentLog = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
		fs.writeFileSync(LOG_FILE, currentLog + entry);
		queue.shift();
		processing = false;
		setImmediate(processQueue);
	} catch (err) {
		// If locked or file descriptor is temporarily bad (e.g. network drive sync), wait 200ms and retry
		setTimeout(() => {
			processing = false;
			processQueue();
		}, 200);
	}
}

function enqueueLog(logEntry) {
	queue.push(logEntry);
	processQueue();
}

function sanitizePayload(obj) {
	if (!obj) return obj;
	try {
		const clone = JSON.parse(JSON.stringify(obj));
		const traverse = (item) => {
			if (typeof item === "object" && item !== null) {
				for (const key in item) {
					if (typeof item[key] === "string" && item[key].startsWith("data:image/")) {
						const originalLength = item[key].length;
						item[key] = `${item[key].substring(0, 30)}... [BASE64 IMAGE DATA TRUNCATED, original size: ${originalLength} chars]`;
					} else {
						traverse(item[key]);
					}
				}
			}
		};
		traverse(clone);
		return clone;
	} catch (e) {
		return "[Un-serializable Payload]";
	}
}

function truncateString(str, maxLen = 300) {
	if (typeof str !== "string") str = String(str);
	if (str.length <= maxLen) return str;
	const half = Math.floor((maxLen - 20) / 2);
	return `${str.substring(0, half)} ... [TRUNCATED] ... ${str.substring(str.length - half)}`;
}

function logAPIInteraction(type, label, requestBody, responseDataOrError) {
	const timestamp = new Date().toISOString();
	
	// Create a safe filename base
	const dateStr = timestamp.replace(/[:.]/g, "-");
	const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, "_");
	const payloadFileName = `${dateStr}_${type}_${safeLabel}.json`;
	const payloadFilePath = path.join(PAYLOADS_DIR, payloadFileName);
	
	const isError = responseDataOrError instanceof Error || (responseDataOrError && responseDataOrError.message && !responseDataOrError.data);
	const responseStatus = isError ? "FAILURE" : "SUCCESS";
	
	let responseText = "";
	if (isError) {
		responseText = responseDataOrError.message || String(responseDataOrError);
	} else if (responseDataOrError && typeof responseDataOrError === "object") {
		responseText = JSON.stringify(responseDataOrError, null, 2);
	} else {
		responseText = String(responseDataOrError);
	}
	
	// 1. Write the full payload file (UNTRUNCATED — includes full base64 images etc.)
	const fullPayloadData = {
		timestamp,
		type,
		label,
		status: responseStatus,
		request: requestBody,
		response: isError ? { error: responseText } : responseDataOrError
	};
	
	try {
		fs.writeFileSync(payloadFilePath, JSON.stringify(fullPayloadData, null, 2) + "\n");
	} catch (err) {
		console.error("⚠️ Failed to write full payload log file:", err.message);
	}
	
	// 2. Format truncated text for the main log (sanitize base64 images etc.)
	const sanitizedRequest = sanitizePayload(requestBody);
	const requestStr = JSON.stringify(sanitizedRequest);
	const truncatedRequest = truncateString(requestStr, 400);
	const truncatedResponse = truncateString(responseText, 400);
	
	const logEntry = `
================================================================================
TIMESTAMP: ${timestamp}
TYPE:      ${type}
LABEL:     ${label}
STATUS:    ${responseStatus}
FULL PATH: file:///${payloadFilePath.replace(/\\/g, "/")}
--------------------------------------------------------------------------------
REQUEST (truncated):
${truncatedRequest}

RESPONSE/ERROR (truncated):
${truncatedResponse}
================================================================================
`;
	
	enqueueLog(logEntry);
}

module.exports = { logAPIInteraction };
