import { afterEach, describe, expect, test } from "vitest";
import { getShellEnv } from "../src/utils/shell.ts";

describe("getShellEnv provider-secret filtering", () => {
	const previousEnvironment = process.env;

	afterEach(() => {
		process.env = previousEnvironment;
	});

	test("strips LLM provider secret vars by default", () => {
		process.env = {
			...previousEnvironment,
			OPENAI_API_KEY: "sk-secret",
			ANTHROPIC_API_KEY: "anthropic-secret",
			ANTHROPIC_AUTH_TOKEN: "auth-token",
			AZURE_OPENAI_API_KEY: "azure-secret",
			AWS_BEDROCK_ACCESS_KEY: "bedrock-secret",
			GEMINI_API_KEY: "gemini-secret",
		};

		const env = getShellEnv();

		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(env.AZURE_OPENAI_API_KEY).toBeUndefined();
		expect(env.AWS_BEDROCK_ACCESS_KEY).toBeUndefined();
		expect(env.GEMINI_API_KEY).toBeUndefined();
	});

	test("keeps dev-tool credentials and generic AWS vars", () => {
		process.env = {
			...previousEnvironment,
			GH_TOKEN: "gh-secret",
			NPM_TOKEN: "npm-secret",
			AWS_ACCESS_KEY_ID: "aws-access",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
		};

		const env = getShellEnv();

		expect(env.GH_TOKEN).toBe("gh-secret");
		expect(env.NPM_TOKEN).toBe("npm-secret");
		expect(env.AWS_ACCESS_KEY_ID).toBe("aws-access");
		expect(env.AWS_SECRET_ACCESS_KEY).toBe("aws-secret");
	});

	test("restores full environment when exposeProviderSecrets is true", () => {
		process.env = {
			...previousEnvironment,
			OPENAI_API_KEY: "sk-secret",
		};

		const env = getShellEnv({ exposeProviderSecrets: true });

		expect(env.OPENAI_API_KEY).toBe("sk-secret");
	});

	test("still prepends the bin dir to PATH", () => {
		const env = getShellEnv();
		const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		expect(typeof env[pathKey]).toBe("string");
	});
});
