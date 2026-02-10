export interface HTTPTransportConfig {
  url: string;
}

export function createHTTPTransport(config: HTTPTransportConfig) {
  return {
    type: 'http' as const,
    url: config.url
  };
}