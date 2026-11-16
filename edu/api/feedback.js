import { handleFeedback } from '../server/feedback.js';
import { mount } from '../server/http.js';

const { onRequest, handler } = mount(handleFeedback);
export { onRequest };
export default handler;
