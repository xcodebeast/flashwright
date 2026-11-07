'use strict';
const ansiRegex = require('../ansi-regex/index.js');

module.exports = string => typeof string === 'string' ? string.replace(ansiRegex(), '') : string;
