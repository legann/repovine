import dockerCompose from '@repovine/plugin-iac-docker-compose';
import dockerfile from '@repovine/plugin-iac-dockerfile';
import helm from '@repovine/plugin-iac-helm';
import kubernetes from '@repovine/plugin-iac-kubernetes';
import sam from '@repovine/plugin-iac-sam';
import terraform from '@repovine/plugin-iac-terraform';
import vercel from '@repovine/plugin-iac-vercel';
import python from '@repovine/plugin-source-python';
import typescript from '@repovine/plugin-source-typescript';

export const defaultPreset = Object.freeze({
  id: 'default',
  activation: 'scaffold-only',
  plugins: Object.freeze([
    typescript,
    python,
    sam,
    kubernetes,
    helm,
    terraform,
    vercel,
    dockerfile,
    dockerCompose,
  ]),
} as const);

export default defaultPreset;
