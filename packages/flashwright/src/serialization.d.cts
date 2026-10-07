export interface CodecErrorDetails {
  code: 'UnsupportedFeatureError' | 'ResourceLimitError' | 'ProtocolError' | 'EvaluationError';
  messageUnits: number[];
  messageTruncated: boolean;
}
export function createValueCodec(): {
  encode(value: unknown): unknown;
  decode(value: unknown): unknown;
  describeError(error: unknown, classifyCodecFailure?: boolean): CodecErrorDetails;
};
