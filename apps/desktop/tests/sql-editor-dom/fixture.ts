import { createApp } from 'vue'
import Fixture from './Fixture.vue'

// This entry deliberately does not import App, useWorkbench, backend, or storage.
createApp(Fixture).mount('#app')
