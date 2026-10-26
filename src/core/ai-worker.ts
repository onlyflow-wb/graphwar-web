/// <reference lib="webworker" />
import { AiEngine, type AiIn } from './ai-engine';

const engine = new AiEngine(m => postMessage(m));
self.onmessage = (e: MessageEvent<AiIn>) => engine.handle(e.data);
