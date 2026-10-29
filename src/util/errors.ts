/** Error with a message meant for the model/user (no stack trace noise). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
