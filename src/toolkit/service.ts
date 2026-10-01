// Client for the local helper service (services/toolkit_server.py). The heavy
// steps that cannot run in the browser (ML models, native tools) live there;
// it listens on this machine only.

const SERVICE_URL = 'http://127.0.0.1:3002';

const START_HINT = 'The local toolkit service is not running. Start it in a terminal from the project folder with:  npm run toolkit:server';

// which tools the service offers, or null when it is not running
const serviceTools = async (): Promise<Record<string, boolean> | null> => {
    try {
        const response = await fetch(`${SERVICE_URL}/health`);
        return response.ok ? (await response.json()).tools : null;
    } catch {
        return null;
    }
};

// run a tool: sends `body`, resolves with the bytes it returns
const callTool = async (tool: string, body: Blob, params: Record<string, string> = {}): Promise<ArrayBuffer> => {
    let response: Response;
    try {
        response = await fetch(`${SERVICE_URL}/${tool}?${new URLSearchParams(params)}`, { method: 'POST', body });
    } catch {
        throw new Error(START_HINT);
    }
    if (!response.ok) {
        let detail = `${response.status}`;
        try {
            detail = (await response.json()).error ?? detail;
        } catch {
            // keep the status code
        }
        throw new Error(`The toolkit service failed on '${tool}': ${detail}`);
    }
    return await response.arrayBuffer();
};

export { SERVICE_URL, START_HINT, serviceTools, callTool };
