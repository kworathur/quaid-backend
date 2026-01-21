import { APIGatewayProxyResult } from 'aws-lambda';

class ServerResponse {
  private message: string;
  private error: string;
  constructor(responseType: ResponseType) {
    // initialize message and error to defaults
  }

  build(): APIGatewayProxyResult {
    return { statusCode: 200, body: JSON.stringify({ message: 'created' }) };
  }
}

export default ServerResponse;
