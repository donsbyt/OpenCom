import { command, createServerContext, optionString } from "../../lib/opencom-extension-sdk.js";

let isConnected = false

async function fetchJson(url) {
    const res = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json"
        }
    });

    if (!res.ok) {
        return null;
    }

    return res.json().catch(() => null);
}

async function auth_with_panel(config) {
  if (!config.panelURL || !config.syncSecret) {
    return false
  };

  data = await fetchJson(`${config.panelURL}?secret=${encodeURLComponent(config.syncSecret)}`)
  if (!data.success) {
    return false
  };

  if (!data.authenticated) {
    return false
  };
  if (data.authenticated == True || !data.insecure) {
    isConnected = true
    return true
  } else {
    return false
  };

async function get_queue(config) {
  data = await fetchJson(`${config.panelURL}?secret=${encodeURLComponent(config.syncSecret)}`)
  if (!data.success) {
    return None
  };
  const queue = data.queue
  if (!queue) {
    return None
  }
  return None // TODO: Implement the proper handelling logic here
}
    
  
export const commands = [
  command({
    name: "moderation-utils-status",
    description: "Simple command to show the status of the Moderation Utils Status",
    options: [],
    async execute(ctx) {
      const me = await ctx.apis.node.get("/v1/me").catch(() => null);
      return {
        content: `Moderation Utils Status\n Connected to panel: ${status}\n Currently Running in app: true`,
        user: me?.user?.username || ctx.userId,
        serverId: ctx.serverId
      };
    }
  }),
];

export async function activate(ctx) {
  const context = createServerContext(ctx);
  context.log(`Activated for server ${ctx.serverId}`);
}

export async function deactivate(ctx) {
  const context = createServerContext(ctx);
  context.log(`Deactivated for server ${ctx.serverId}`);
}
