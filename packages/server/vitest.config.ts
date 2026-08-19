import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: {
			"@earendil-works/pi-protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
			"@earendil-works/pi-client/websocket": fileURLToPath(new URL("../client/src/websocket.ts", import.meta.url)),
			"@earendil-works/pi-client": fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
		},
	},
});
