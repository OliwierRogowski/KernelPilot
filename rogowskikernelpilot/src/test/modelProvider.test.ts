import * as assert from 'assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestModelCompletion } from '../modelProvider';

suite('Model provider transport', () => {
	let server: ReturnType<typeof createServer>;
	let endpoint = '';
	let respond: (request: IncomingMessage, response: ServerResponse) => void;

	suiteSetup(async () => {
		server = createServer((request, response) => respond(request, response));
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	suiteTeardown(async () => {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	});

	test('sends the Ollama chat schema to its local endpoint', async () => {
		let observedUrl = '';
		let observedBody: Record<string, unknown> = {};
		respond = (request, response) => {
			observedUrl = request.url ?? '';
			let body = '';
			request.setEncoding('utf8');
			request.on('data', chunk => body += chunk);
			request.on('end', () => {
				observedBody = JSON.parse(body) as Record<string, unknown>;
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ message: { content: 'local answer' } }));
			});
		};
		const answer = await requestModelCompletion({
			provider: 'ollama', endpoint, model: 'test-model',
			messages: [{ role: 'user', content: 'hello' }], format: 'json',
			options: { num_predict: 123, temperature: 0.2 }
		});
		assert.strictEqual(answer, 'local answer');
		assert.strictEqual(observedUrl, '/api/chat');
		assert.strictEqual(observedBody.model, 'test-model');
		assert.strictEqual(observedBody.format, 'json');
		assert.strictEqual((observedBody.options as Record<string, number>).num_predict, 123);
	});

	test('maps OpenAI-compatible options and credentials', async () => {
		let observedUrl = '';
		let observedAuthorization = '';
		let observedBody: Record<string, unknown> = {};
		respond = (request, response) => {
			observedUrl = request.url ?? '';
			observedAuthorization = request.headers.authorization ?? '';
			let body = '';
			request.setEncoding('utf8');
			request.on('data', chunk => body += chunk);
			request.on('end', () => {
				observedBody = JSON.parse(body) as Record<string, unknown>;
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ choices: [{ message: { content: 'compatible answer' } }] }));
			});
		};
		const answer = await requestModelCompletion({
			provider: 'openai-compatible', endpoint, apiKey: 'test-secret', model: 'compatible-model',
			messages: [{ role: 'user', content: 'hello' }], format: 'json',
			options: { num_predict: 64, temperature: 0.1 }
		});
		assert.strictEqual(answer, 'compatible answer');
		assert.strictEqual(observedUrl, '/v1/chat/completions');
		assert.strictEqual(observedAuthorization, 'Bearer test-secret');
		assert.deepStrictEqual(observedBody.response_format, { type: 'json_object' });
		assert.strictEqual(observedBody.max_tokens, 64);
	});

	test('rejects absent credentials and insecure remote endpoints before connecting', async () => {
		await assert.rejects(requestModelCompletion({
			provider: 'openai-compatible', endpoint, model: 'model', messages: []
		}), /KERNELPILOT_API_KEY/);
		await assert.rejects(requestModelCompletion({
			provider: 'openai-compatible', endpoint: 'http://example.invalid', apiKey: 'secret',
			model: 'model', messages: []
		}), /must use HTTPS/);
	});

	test('does not duplicate the version path for a compatible API base URL', async () => {
		let observedUrl = '';
		respond = (request, response) => {
			observedUrl = request.url ?? '';
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
		};
		await requestModelCompletion({
			provider: 'openai-compatible', endpoint: `${endpoint}/v1`, apiKey: 'test-secret',
			model: 'model', messages: []
		});
		assert.strictEqual(observedUrl, '/v1/chat/completions');
	});

	test('reports malformed and empty provider responses', async () => {
		respond = (_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('not-json');
		};
		await assert.rejects(requestModelCompletion({
			provider: 'ollama', endpoint, model: 'model', messages: []
		}), /malformed JSON/);
		respond = (_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"choices":[]}');
		};
		await assert.rejects(requestModelCompletion({
			provider: 'openai-compatible', endpoint, apiKey: 'test-secret', model: 'model', messages: []
		}), /empty or unsupported response/);
	});

	test('retries a provider-truncated answer with a bounded larger output budget and compact retry', async () => {
		const budgets: number[] = [];
		const prompts: unknown[] = [];
		respond = (request, response) => {
			let body = '';
			request.setEncoding('utf8');
			request.on('data', chunk => body += chunk);
			request.on('end', () => {
				const parsed = JSON.parse(body) as { max_tokens: number; messages: unknown[] };
				budgets.push(parsed.max_tokens);
				prompts.push(parsed.messages);
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify(budgets.length < 3
					? { id: 'resp-test', model: 'test-model', usage: { prompt_tokens: 50, completion_tokens: parsed.max_tokens }, choices: [{ finish_reason: 'length', message: { content: 'partial {' } }] }
					: { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: 'complete adapter' }] } }] }));
			});
		};
		const answer = await requestModelCompletion({
			provider: 'openai-compatible', endpoint, apiKey: 'test-secret', model: 'test-model',
			messages: [{ role: 'user', content: 'generate adapter' }], options: { num_predict: 128 }
		});
		assert.strictEqual(answer, 'complete adapter');
		assert.deepStrictEqual(budgets, [128, 256, 512]);
		assert.ok(JSON.stringify(prompts[1]).includes('complete requested artifact'));
		assert.ok(!JSON.stringify(prompts[2]).includes('partial {'));
	});

	test('reports truncation metadata after the retry budget is exhausted', async () => {
		let calls = 0;
		respond = (request, response) => {
			calls++;
			request.resume();
			request.on('end', () => {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ id: 'resp-safe', model: 'model', usage: { prompt_tokens: 20, completion_tokens: 512 }, choices: [{ finish_reason: 'length', message: { content: '' } }] }));
			});
		};
		await assert.rejects(requestModelCompletion({
			provider: 'openai-compatible', endpoint, apiKey: 'secret-never-logged', model: 'model', messages: [], options: { num_predict: 128 }
		}), error => {
			const message = error instanceof Error ? error.message : String(error);
			assert.ok(message.includes('OUTPUT_TRUNCATED') || message.includes('truncated by the provider'));
			assert.ok(message.includes('completionTokens'));
			assert.ok(!message.includes('secret-never-logged'));
			return true;
		});
		assert.strictEqual(calls, 3);
	});

	test('distinguishes invalid credentials and provider rate limits', async () => {
		for (const [status, message] of [[401, /rejected the configured credentials/], [429, /rate limit reached/]] as const) {
			respond = (_request, response) => {
				response.writeHead(status);
				response.end('{}');
			};
			await assert.rejects(requestModelCompletion({
				provider: 'openai-compatible', endpoint, apiKey: 'test-secret', model: 'model', messages: []
			}), message);
		}
	});

	test('uses the configured timeout and reports timeout separately', async () => {
		const timeoutFetcher: typeof fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
		await assert.rejects(requestModelCompletion({
			provider: 'ollama', endpoint, model: 'model', messages: [], timeoutMs: 25
		}, timeoutFetcher), /timed out after 25 ms/);
	});

	test('redacts credentials echoed by provider error payloads', async () => {
		respond = (_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ error: { message: 'invalid token test-secret' } }));
		};
		let errorMessage = '';
		try {
			await requestModelCompletion({ provider: 'openai-compatible', endpoint, apiKey: 'test-secret', model: 'model', messages: [] });
		} catch (error) {errorMessage = error instanceof Error ? error.message : String(error);}
		assert.ok(errorMessage.includes('[redacted]'));
		assert.ok(!errorMessage.includes('test-secret'));
	});
});
