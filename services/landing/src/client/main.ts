import './styles/product.css';
import './styles/pending.css';
import { mountLocalePreference } from './app/locale-preference.ts';
import { mountLocaleToggle } from './app/nav.ts';
import { mountProduct } from './app/product.ts';
mountLocalePreference();
mountLocaleToggle();
mountProduct();
document.body.dataset.ready='1';
