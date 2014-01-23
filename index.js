'use strict';

var tty = require('tty');
var util = require('util');
var WritableStream = require('stream').Writable;

var stash = {
  log: console.log,
  info: console.info,
  error: console.error,
  warn: console.warn
}

var definition = {
  colors: {
    normal          : 39,
    white           : 37,
    black           : 30,
    blue            : 34,
    cyan            : 36,
    green           : 32,
    yellow          : 33,
    magenta         : 35,
    red             : 31
  },
  bg: {
    colors: {
      normal        : 49,
      white         : 47,
      black         : 40,
      blue          : 44,
      cyan          : 46,
      green         : 42,
      yellow        : 43,
      magenta       : 45,
      red           : 41
    }
  },
  attrs: {
    bright          : 1,
    dim             : 2,
    italic          : 3,
    underline       : 4,
    blink           : 5,
    reverse         : 7
  }
}

var ANSI_OPEN = '\u001b[';
var ANSI_FINAL = 'm';
var ANSI_CLOSE_CODE = '0';
var ANSI_CLOSE = ANSI_OPEN + ANSI_CLOSE_CODE + ANSI_FINAL;

/**
 *  Low-level method for creating escaped string sequences.
 *
 *  @param value The value to escape.
 *  @param code The color code.
 *  @param attr An optional attribute code.
 */
function stringify(value, code, attr) {
  var s = attr ? ANSI_OPEN + attr + ';' + code + ANSI_FINAL
    : ANSI_OPEN + code + ANSI_FINAL;
  s += value + ANSI_CLOSE;
  return s;
}

/**
 *  Escapes replacement values.
 *
 *  @param options.tty A boolean indicating whether the output is a tty.
 *  @param options.method A method to proxy to.
 *  @param options.stream A writable stream to write to.
 *
 *  @param options Write options.
 *  @param format The format string.
 *  @param ... The format string arguments.
 */
function proxy(options, format) {
  var tty = options.tty, method = options.method, re = /(%[sdj])+/g;
  if(arguments.length == 1) return method.apply(console, []);
  var arg, i, json, replacing, replacements, matches;
  replacing = (typeof format == 'string')
    && re.test(format) && arguments.length > 2;
  replacements = [].slice.call(arguments, 2);
  if(format instanceof AnsiColor) {
    replacing = true;
    if(!replacements.length) {
      replacements.unshift(format); format = '%s';
    }
  }
  if(!replacing) {
    replacements.unshift(format);
    return method.apply(console, replacements);
  }
  matches = (format && (typeof format.match == 'function')) ?
    format.match(re) : [];
  for(i = 0;i < replacements.length;i++) {
    arg = replacements[i];
    json = (matches[i] == '%j');
    if(arg instanceof AnsiColor) {
      if(json && tty) {
        arg.v = JSON.stringify(arg.v);
      }
      replacements[i] = arg.valueOf(tty);
    }else if(json && tty){
      replacements[i] = JSON.stringify(replacements[i]);
    }
  }
  if(format instanceof AnsiColor) {
    format = format.valueOf(tty);
  }
  // we have already coerced to strings
  if(tty) {
    for(i = 0;i < replacements.length;i++) {
      format = format.replace(/%[jd]/, '%s');
    }
  }
  replacements.unshift(format);
  return method.apply(options.scope ? options.scope : console, replacements);
}

/**
 *  Chainable color builder.
 *
 *  @param value The underlying value to be escaped.
 *  @param key The key for the code lookup.
 *  @param parent A parent color instance.
 */
var AnsiColor = function(value, key, parent){
  this.t = definition.colors;
  this.v = value;
  this.k = key;
  this.p = parent;
  this.a = null;
};

/**
 *  Retrieve an escape sequence from the chain.
 *
 *  @param tty Whether the output stream is a terminal.
 */
AnsiColor.prototype.valueOf = function(tty) {
  if(!tty) return this.v;
  var list = [this], p = this.p, i;
  while(p) {
    if(p) {
      list.push(p);
    }
    p = p.p;
  }
  list.reverse();
  for(i = 0;i < list.length;i++){
    p = list[i];
    if(!p.k) continue;
    this.v = stringify(this.v, p.t[p.k], p.a);
  }
  return this.v;
}

AnsiColor.prototype.__defineGetter__('bg', function() {
  var ansi = new AnsiColor(this.v, this.k, this);
  ansi.t = definition.bg.colors;
  return ansi;
});

/**
 *  Write a writable stream.
 *
 *  @param options.stream A writable stream.
 *  @param options.callback A callback to invoke once the data is written.
 *  @param format The format string.
 *  @param ...  The format string arguments.
 */
console.write = function(options) {
  var stream = options.stream;
  if(stream instanceof WritableStream) {
    if(stream.fd == null) {
      throw new Error('Cannot write to stream, file descriptor not open');
    }
    var args = [{scope: util, method: util.format, tty: tty.isatty(stream.fd)}];
    args = args.concat([].slice.call(arguments, 1));
    var value = proxy.apply(null, args);
    stream.write(value, function() {
      if(typeof options.callback == 'function') options.callback(value);
    });
  }else{
    throw new Error('Stream option must be writable');
  }
}

// console functions
Object.keys(stash).forEach(function (k) {
  var stream = (k == 'info' || k == 'log') ?
    process.stdout : process.stderr;
  console[k] = function(format) {
    var tty = stream.isTTY;
    var args = [{tty: tty, method: stash[k]}];
    var rest = [].slice.call(arguments, 0);
    args = args.concat(rest);
    proxy.apply(null, args);
  }
});

// attributes
Object.keys(definition.attrs).forEach(function (k) {
  AnsiColor.prototype.__defineGetter__(k, function () {
    if(this.a) {
      var ansi = new AnsiColor(this.v, this.k || 'normal', this);
      ansi.a = definition.attrs[k];
      return ansi;
    }
    this.a = definition.attrs[k];
    this.k = this.k || 'normal';
    return this;
  });
});

// colors
Object.keys(definition.colors).forEach(function (k) {
  AnsiColor.prototype.__defineGetter__(k, function () {
    // reset the background color chain after color method invocation
    // allows invoking foreground colors after background colors
    if(this.k && this.t == definition.bg.colors && this.p && !this.p.k) {
      return new AnsiColor(this.v, k, this);
    }
    this.k = k;
    return this;
  });
});

module.exports = {
  console: stash,
  ansi: function(v) {
    return new AnsiColor(v);
  },
  colors: Object.keys(definition.colors),
  attributes: definition.attrs,
  foreground: definition.colors,
  background: definition.bg.colors,
  stringify: stringify,
  debug: function() {
    var args = [{scope: util, method: util.format, tty: true}];
    args = args.concat([].slice.call(arguments, 0));
    return proxy.apply(null, args);
  }
}
