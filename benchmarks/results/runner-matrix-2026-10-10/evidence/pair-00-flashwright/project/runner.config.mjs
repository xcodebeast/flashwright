import { defineConfig } from './adapter.mjs';
const configuration = {"testDir":".","testMatch":"workloads.spec.mjs","workers":1,"retries":0,"repeatEach":1,"fullyParallel":false,"maxFailures":0,"forbidOnly":true,"timeout":30000,"expect":{"timeout":5000},"outputDir":"/retained/runner-matrix/pair-00-flashwright/test-output","reporter":[["json",{"outputFile":"/retained/runner-matrix/pair-00-flashwright/runner-report.json"}]],"use":{"headless":true,"viewport":{"width":1280,"height":720},"launchOptions":{"executablePath":"/browser/executable"},"trace":"off","video":"off","screenshot":"off","actionTimeout":5000,"navigationTimeout":10000}};
configuration.use.baseURL = process.env.FLASHWRIGHT_TEST_BASE_URL;
export default defineConfig(configuration);
