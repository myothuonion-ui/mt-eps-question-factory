import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppV5 } from './AppV5';
import { QuickApiSettings } from './QuickApiSettings';
import { OneClickBuild } from './OneClickBuild';
import './styles.css';
import './factory-v2.css';
import './factory-v3.css';
import './quick-api.css';
import './one-click.css';
import './v5.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QuickApiSettings />
    <OneClickBuild />
    <AppV5 />
  </React.StrictMode>
);
