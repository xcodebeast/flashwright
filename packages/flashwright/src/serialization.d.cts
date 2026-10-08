export interface CodecErrorDetails {
  code: 'UnsupportedFeatureError' | 'ResourceLimitError' | 'ProtocolError' | 'EvaluationError';
  messageUnits: number[];
  messageTruncated: boolean;
}
export function createValueCodec(): {
  encode(value: unknown, handleIndex?: (value: unknown) => number | undefined): unknown;
  decode(value: unknown, handles?: unknown[]): unknown;
  describeError(error: unknown, classifyCodecFailure?: boolean): CodecErrorDetails;
};
