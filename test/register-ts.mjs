/**
 * Install the `.js` to `.ts` resolve hook for the unit suite.
 *
 * Separate from the hook itself because a resolve hook runs on its own thread
 * and has to be registered from the main one.
 */
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
