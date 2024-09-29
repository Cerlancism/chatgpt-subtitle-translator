import fs from 'node:fs'

import test from 'node:test';
import assert from 'node:assert';

import { subtitleParser } from "../src/main.mjs";

test('should correctly modify and convert SRT data', () =>
{
  const srtString = "1\n00:00:00,000 --> 00:00:02,000\nHello, world!\n";
  const parsedSrt = subtitleParser.fromSrt(srtString);

  parsedSrt[0].id = "100";
  const convertedSrt = subtitleParser.toSrt(parsedSrt);
  const expectedOutput = "100\r\n00:00:00,000 --> 00:00:02,000\r\nHello, world!\r\n\r\n";

  assert.strictEqual(convertedSrt, expectedOutput, 'Converted SRT should match the expected output');
});
