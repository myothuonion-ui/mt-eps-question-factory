import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { QuickApiSettings } from './QuickApiSettings';
import { OneClickBuild } from './OneClickBuild';
import './styles.css';
import './factory-v2.css';
import './factory-v3.css';
import './quick-api.css';
import './one-click.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QuickApiSettings />
    <OneClickBuild />
    <App />
  </React.StrictMode>
);
