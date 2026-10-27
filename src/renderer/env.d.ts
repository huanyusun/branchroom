/// <reference types="vite/client" />
import type { ExposedBranchroomAPI } from '../shared/contracts';

declare global {
  interface Window {
    branchroom: ExposedBranchroomAPI;
  }
}

export {};
