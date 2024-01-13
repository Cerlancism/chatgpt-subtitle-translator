import fs from 'node:fs'

import test from 'node:test';
import assert from 'node:assert';

import { parser, secondsToTimestamp, splitStringByNumberLabel } from "../src/subtitle.mjs";

test('should correctly modify and convert SRT data', () =>
{
  const srtString = "1\n00:00:00,000 --> 00:00:02,000\nHello, world!\n";
  const parsedSrt = parser.fromSrt(srtString);

  parsedSrt[0].id = "100";
  const convertedSrt = parser.toSrt(parsedSrt);

  // Define the expected output string
  const expectedOutput = "100\r\n00:00:00,000 --> 00:00:02,000\r\nHello, world!\r\n\r\n";

  // Assert that the output is as expected
  assert.strictEqual(convertedSrt, expectedOutput, 'Converted SRT should match the expected output');
});