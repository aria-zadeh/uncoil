// registers the `@/` resolver hook: node --import ./scripts/verify/ts-alias-register.mjs <script>
import { register } from 'node:module';

register('./ts-alias-hooks.mjs', import.meta.url);
