import { splitText } from './engine.js';
self.addEventListener('message', event => {
  const { id, text } = event.data;
  try { self.postMessage({ id, chunks: splitText(text) }); }
  catch (error) { self.postMessage({ id, error: String(error.message) }); }
});
