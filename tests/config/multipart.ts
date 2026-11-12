/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Readable } from 'stream';

import formidable from 'formidable';

import type { IncomingMessage } from 'http';

export type MultipartBody = {
  fields: Record<string, string>;
  files: Record<string, formidable.File>;
};

// Parses a multipart request the test server received. The server reads every request body as it
// arrives, and formidable 3 only starts listening a tick later, so it gets the body the server
// buffered. formidable gives each field and file as an array; this keeps the first of each.
export async function parseMultipart(request: IncomingMessage, options?: formidable.Options): Promise<MultipartBody> {
  const body = await (request as IncomingMessage & { postBody: Promise<Buffer> }).postBody;
  const stream = Object.assign(Readable.from([body]), { headers: request.headers });
  const [fields, files] = await formidable(options).parse(stream as unknown as IncomingMessage);
  return { fields: firstValues(fields), files: firstValues(files) };
}

function firstValues<T>(record: Record<string, T[] | undefined>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, values]) => [key, values?.[0]])) as Record<string, T>;
}
