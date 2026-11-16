import { createApp } from 'vue';
import App from './App.vue';
import { installClientErrorLogging } from './lib/clientLogger.js';
import './styles.css';

installClientErrorLogging();

createApp(App).mount('#app');
