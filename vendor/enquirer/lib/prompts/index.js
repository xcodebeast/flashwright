'use strict';

const utils = require('../utils');

const define = (key, fn) => {
  utils.defineExport(exports, key, fn);
  utils.defineExport(exports, key.toLowerCase(), fn);
};

define('Input', () => require('./input'));
define('MultiSelect', () => require('./multiselect'));
define('Select', () => require('./select'));
define('Text', () => require('./text'));
