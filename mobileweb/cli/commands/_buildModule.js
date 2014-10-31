/**
* MobileWeb module build command.
*
* @module cli/_buildModule
*
* @copyright
* Copyright (c) 2014 by Appcelerator, Inc. All Rights Reserved.
*
* @license
* Licensed under the terms of the Apache Public License
* Please see the LICENSE included with this distribution for details.
*/

var appc = require('node-appc'),
	archiver = require('archiver'),
	archiverCore = require('archiver/lib/archiver/core'),
	async = require('async'),
	Builder = require('titanium-sdk/lib/builder'),
	cleanCSS = require('clean-css'),
	ejs = require('ejs'),
	fields = require('fields'),
	fs = require('fs'),
	i18n = appc.i18n(__dirname),
	jsanalyze = require('titanium-sdk/lib/jsanalyze'),
	path = require('path'),
	ti = require('titanium-sdk'),
	util = require('util'),
	windows = require('titanium-sdk/lib/windows'),
	wrench = require('wrench'),
	__ = i18n.__,
	__n = i18n.__n,
	afs = appc.fs,
	parallel = appc.async.parallel;

// Archiver 0.4.10 has a problem where the stack size is exceeded if the project
// has lots and lots of files. Below is a function copied directly from
// lib/archiver/core.js and modified to use a setTimeout to collapse the call
// stack. Copyright (c) 2012-2013 Chris Talkington, contributors.
archiverCore.prototype._processQueue = function _processQueue() {
	if (this.archiver.processing) {
		return;
	}

	if (this.archiver.queue.length > 0) {
		var next = this.archiver.queue.shift();
		var nextCallback = function(err, file) {
			next.callback(err);

			if (!err) {
				this.archiver.files.push(file);
				this.archiver.processing = false;
				// do a setTimeout to collapse the call stack
				setTimeout(function () {
					this._processQueue();
				}.bind(this), 0);
			}
		}.bind(this);

		this.archiver.processing = true;

		this._processFile(next.source, next.data, nextCallback);
	} else if (this.archiver.finalized && this.archiver.writableEndCalled === false) {
		this.archiver.writableEndCalled = true;
		this.end();
	} else if (this.archiver.finalize && this.archiver.queue.length === 0) {
		this._finalize();
	}
};

ejs.filters.escapeQuotes = function escapeQuotes(s) {
	return String(s).replace(/"/g, '\\"');
};

function MobileWebModuleBuilder() {
	Builder.apply(this, arguments);

	this.imageMimeTypes = {
		'.png': 'image/png',
		'.gif': 'image/gif',
		'.jpg': 'image/jpg',
		'.jpeg': 'image/jpg'
	};

}

util.inherits(MobileWebModuleBuilder, Builder);

MobileWebModuleBuilder.prototype.config = function (logger, config, cli) {
	Builder.prototype.config.apply(this, arguments);

	this.logger.info('--- MobileWebModuleBuilder config --- ');
};

MobileWebModuleBuilder.prototype.validate = function (logger, config, cli) {

	this.cli = cli;
	this.logger = logger;

	this.logger.info('--- MobileWebModuleBuilder validate --- ');

	//TODO: this happens for all modules regardless platform,
	// it would be a better to move this to build.js
	this.manifestFile = path.join(cli.argv['project-dir'], 'manifest');
	this.manifest = {};
	if (!fs.existsSync(this.manifestFile)) {
		this.logger.error(__('Missing %s', this.manifestFile));
		this.logger.log();
		process.exit(1);
	}

	var re = /^(\S+)\s*:\s*(.*)$/,
		match,
		requiredModuleKeys = [
			'name',
			'version',
			'moduleid',
			'description',
			'copyright',
			'license',
			'copyright',
			'platform',
			'minsdk'
		];

	fs.readFileSync(this.manifestFile).toString().split('\n').forEach(function (line) {
		match = line.match(re);
		if (match) {
			this.manifest[match[1].trim()] = match[2].trim();
		}
	}, this);

	// check if all the required module keys are in the list
	requiredModuleKeys.forEach(function (key) {
		if (!this.manifest[key]) {
			this.logger.error(__('Missing required manifest key "%s"', key));
			this.logger.log();
			process.exit(1);
		}
	}.bind(this));

	dump(this.manifest);

	this.srcDir = path.join(cli.argv['project-dir'], 'src');
	this.mainjs = path.join(this.srcDir, this.manifest.moduleid + '.js');
	if (!fs.existsSync(this.mainjs)) {
		this.logger.error(__('Missing %s', this.mainjs));
		this.logger.log();
		process.exit(1);
	}

};

MobileWebModuleBuilder.prototype.run = function (logger, config, cli, finished) {
	Builder.prototype.run.apply(this, arguments);

	this.logger.info('--- MobileWebModuleBuilder run --- ');

	appc.async.series(this, [
		function (next) {
			cli.emit('build.pre.construct', this, next);
		},

		//'doAnalytics',
		'initialize',
		'loginfo',

		function (next) {
			cli.emit('build.pre.compile', this, next);
		},

		'compileModule',
		'copySrc',
		'buildJs',
		'minifyJs',
		'packageModule',

		function (next) {
			cli.emit('build.post.compile', this, next);
		}
	], function (err) {
		cli.emit('build.finalize', this, function () {
			finished(err);
		});
	});
};

MobileWebModuleBuilder.prototype.doAnalytics = function (next) {

	var cli = this.cli,
		manifest = this.manifest,
		eventName = 'mobileweb.' + cli.argv.type;

	cli.addAnalyticsEvent(eventName, {
		dir: cli.argv['project-dir'],
		name: manifest.name,
		publisher: manifest.author,
		appid: manifest.moduleid,
		description: manifest.description,
		type: cli.argv.type,
		guid: manifest.guid,
		version: manifest.version,
		copyright: manifest.copyright,
		date: (new Date()).toDateString()
	});

	next();
};

MobileWebModuleBuilder.prototype.initialize = function (next) {

	this.mobilewebTitaniumDir = path.join(this.platformPath, 'titanium');
	this.buildDir = path.join(this.projectDir, 'build');

	this.requireCache = {};
	this.moduleMap = {};
	this.modulesToCache = [];

	this.minifyJS = true;

	this.documentation = [];

	['documentation', 'example'].forEach(function (folder) {
		var dirName = folder+'Dir';
		this[dirName] = path.join(this.projectDir, folder);
		if (!fs.existsSync(this[dirName])) {
			this[dirName] = path.join(this.projectDir, '..', folder);
		}
	}, this);

	this.licenseFile = path.join(this.projectDir, 'LICENSE');
	if (!fs.existsSync(this.licenseFile)) {
		this.licenseFile = path.join(this.projectDir, '..', 'LICENSE');
	}

	next();
};

MobileWebModuleBuilder.prototype.loginfo = function (next) {

	this.logger.info(__('Project Dir: %s', this.projectDir.cyan));
	this.logger.info(__('Build Dir: %s', this.buildDir.cyan));
	this.logger.info(__('Source Dir: %s', this.srcDir.cyan));
	next();
};

MobileWebModuleBuilder.prototype.dirWalker = function (currentPath, callback) {
	var files = fs.readdirSync(currentPath);
	for (var i in files) {
		var currentFile = path.join(currentPath, files[i]);
		var stats = fs.statSync(currentFile);

		if (stats.isFile()) {
			callback(currentFile);
		} else if (stats.isDirectory()) {
			this.dirWalker(currentFile, callback);
		}
	}
};

MobileWebModuleBuilder.prototype.compileModule = function (next) {

	this.parseModule(this.manifest.moduleid, null);

	this.modulesToCache = [];
	this.precacheImages = [];

	for ( var item in this.requireCache) {
		if ( item != this.manifest.moduleid && fs.existsSync(path.join(this.buildDir, item + '.js'))) {
			this.modulesToCase.push(item);
		}
	}

	if ('precache' in this.timodule) {
		if ('requires' in this.timodule['precache'] && (this.timodule['precache']['requires']).length) {
			for ( var req in this.timodule['precache']['requires']) {
				this.modulesToCase.push(req);
			}
		}

		if ('images' in this.timodule['precache'] && (this.timodule['precache']['images']).length) {
			for ( var img in this.timodule['precache']['images']) {
				this.precacheImages.push(img);
			}
		}
	}

	next();
},

MobileWebModuleBuilder.prototype.copySrc = function (next) {

	fs.existsSync(this.buildDir) && wrench.rmdirSyncRecursive(this.buildDir);
	wrench.mkdirSyncRecursive(this.buildDir);
	wrench.copyDirSyncRecursive(this.srcDir, this.buildDir, { forceDelete: true });

	next();
},

MobileWebModuleBuilder.prototype.buildJs = function (next) {

	var srcFile = path.join(this.buildDir, this.manifest.moduleid + '.js'),
		tmp = srcFile + '.tmp',
		tiJS = '',
		first = true,
		requireCacheWritten = false,
		moduleCounter = 0;

	this.modulesToCache.forEach(function (moduleName) {
		var isCommonJS = false;
		if (/^commonjs\:/.test(moduleName)) {
			isCommonJS = true;
			moduleName = moduleName.substring(9);
		}

		var dep = this.resolveModuleId(moduleName);
		if (!dep.length) return;

		if (!requireCacheWritten) {
			tiJS += 'require.cache({\n';
			requireCacheWritten = true;
		}

		if (!first) {
			tiJS += ',\n';
		}
		first = false;
		moduleCounter++;

		var file = path.join(dep[0], /\.js$/.test(dep[1]) ? dep[1] : dep[1] + '.js'),
			r;

		try {
			r = jsanalyze.analyzeJsFile(file, { minify: /^url\:/.test(moduleName) });
		} catch (ex) {
			ex.message.split('\n').forEach(this.logger.error);
			this.logger.log();
			process.exit(1);
		}

		if (/^url\:/.test(moduleName)) {
			if (this.minifyJS) {
				this.logger.debug(__('Minifying include %s', file.cyan));
				try {
					fs.writeFileSync(file, r.contents);
				} catch (ex) {
					this.logger.error(__('Failed to minify %s', file));
					if (ex.line) {
						this.logger.error(__('%s [line %s, column %s]', ex.message, ex.line, ex.col));
					} else {
						this.logger.error(__('%s', ex.message));
					}
					try {
						var contents = fs.readFileSync(file).toString().split('\n');
						if (ex.line && ex.line <= contents.length) {
							this.logger.error('');
							this.logger.error('    ' + contents[ex.line-1]);
							if (ex.col) {
								var i = 0,
									len = ex.col;
									buffer = '    ';
								for (; i < len; i++) {
									buffer += '-';
								}
								this.logger.error(buffer + '^');
							}
							this.logger.log();
						}
					} catch (ex2) {}
					process.exit(1);
				}
			}
			tiJS += '"' + moduleName + '":"' + fs.readFileSync(file).toString().trim().replace(/\\/g, '\\\\').replace(/\n/g, '\\n\\\n').replace(/"/g, '\\"') + '"';
		} else if (isCommonJS) {
			tiJS += '"' + moduleName + '":function(){\n/* ' + file.replace(this.buildDir, '') + ' */\ndefine(function(require,exports,module){\n' + fs.readFileSync(file).toString() + '\n});\n}';
		} else {
			tiJS += '"' + moduleName + '":function(){\n/* ' + file.replace(this.buildDir, '') + ' */\n\n' + fs.readFileSync(file).toString() + '\n}';
		}
	}, this);

	this.precacheImages.forEach(function (url) {
		url = url.replace(/\\/g, '/');

		var img = path.join(this.projectDir, /^\//.test(url) ? '.' + url : url),
			m = img.match(/(\.[a-zA-Z]{3,4})$/),
			type = m && this.imageMimeTypes[m[1]];

		if (type && fs.existsSync(img)) {
			if (!requireCacheWritten) {
				tiJS += 'require.cache({\n';
				requireCacheWritten = true;
			}

			if (!first) {
				tiJS += ',\n';
			}
			first = false;
			moduleCounter++;

			tiJS += '"url:' + url + '":"data:' + type + ';base64,' + fs.readFileSync(img).toString('base64') + '"';
		}
	}, this);

	if (requireCacheWritten) {
		tiJS += '});\n';
	}

	tiJS += fs.readFileSync(srcFile).toString();
	fs.writeFileSync(tmp, tiJS);
	fs.unlinkSync(srcFile);
	fs.renameSync(tmp, srcFile);

	next();
},

MobileWebModuleBuilder.prototype.minifyJs = function (next) {

	var self = this;

	(function walk(dir) {
		fs.readdirSync(dir).sort().forEach(function (filename) {
			var file = path.join(dir, filename),
				stat = fs.statSync(file);
			if (stat.isDirectory()) {
				walk(file);
			} else if (/\.js$/.test(filename)) {
				self.logger.debug(self.minifyJS ? __('Minifying %s', file.cyan) : __('Analyzing %s', file.cyan));
				try {
					var r = jsanalyze.analyzeJsFile(file, { minify: self.minifyJS });
					self.minifyJS && fs.writeFileSync(file, r.contents);
					dump(r.contents);
				} catch (ex) {
					ex.message.split('\n').forEach(self.logger.error);
					self.logger.log();
					process.exit(1);
				}
			}
		});
	}(this.buildDir));

	next();
},

MobileWebModuleBuilder.prototype.packageModule = function (next) {

	var tasks = [

		function (cb) {
			// Generate documentation
			if (fs.existsSync(this.documentationDir)) {
				var markdown = require( 'markdown' ).markdown;
				var files = fs.readdirSync(this.documentationDir);
				for (var i in files) {
					var file = files[i],
						currentFile = path.join(this.documentationDir, file);
					if (fs.statSync(currentFile).isFile()) {
						var obj = {},
							contents = fs.readFileSync(currentFile).toString();

						obj[file] = markdown.toHTML(contents);
						this.documentation.push(obj);
					}
				}
			}
			cb();
		},

		function (cb) {
			// Package zip
			var dest = archiver('zip', {
					forceUTC: true
				}),
				pckJson = {
					name: this.manifest.name,
					description: this.manifest.description,
					version: this.manifest.version,
					directories: {
						lib: './src'
					},
					main: this.manifest.moduleid
				},
				zipStream,
				origConsoleError = console.error,
				id = this.manifest.moduleid.toLowerCase(),
				zipName = [this.manifest.moduleid, '-', this.platformName, '-', this.manifest.version, '.zip'].join('');
				moduleZipPath = path.join(this.projectDir, zipName),
				moduleFolder = path.join('modules', this.platformName, this.manifest.moduleid, this.manifest.version);

			// since the archiver library didn't set max listeners, we squelch all error output
			console.error = function () {};

			try {
				// if the zip file is there, remove it
				fs.existsSync(moduleZipPath) && fs.unlinkSync(moduleZipPath);
				zipStream = fs.createWriteStream(moduleZipPath);
				zipStream.on('close', function() {
					console.error = origConsoleError;
					cb();
				});
				dest.catchEarlyExitAttached = true; // silence exceptions
				dest.pipe(zipStream);

				this.logger.info(__('Creating module zip'));

				// 1. documentation folder
				this.documentation.forEach(function (item) {
					var fileName = Object.keys(item),
						content = item[fileName],
						filePath;

					fileName = fileName.toString().replace('.md', '.html');
					filePath = path.join(moduleFolder, 'documentation', fileName);

					dest.append(content, { name: filePath });

				}, this);


				dest.append(JSON.stringify(pckJson), { name: path.join(moduleFolder,'package.json') });

				this.dirWalker(this.exampleDir, function (file) {
					dest.append(fs.createReadStream(file), { name: path.join(moduleFolder, 'example', path.relative(this.exampleDir, file)) });
				}.bind(this));

				this.dirWalker(this.buildDir, function (file) {
					dest.append(fs.createReadStream(file), { name: path.join(moduleFolder, 'src', path.relative(this.buildDir, file)) });
				}.bind(this));

				dest.append(fs.createReadStream(this.licenseFile), { name: path.join(moduleFolder,'LICENSE') });
				dest.append(fs.createReadStream(this.manifestFile), { name: path.join(moduleFolder,'manifest') });

				this.logger.info(__('Writing module zip: %s', moduleZipPath));
				dest.finalize();
			} catch (ex) {
				console.error = origConsoleError;
				throw ex;
			}
		}
	];
	appc.async.series(this, tasks, next);
},

MobileWebModuleBuilder.prototype.collapsePath = function (p) {
	var result = [], segment, lastSegment;
	p = p.replace(/\\/g, '/').split('/');
	while (p.length) {
		segment = p.shift();
		if (segment == '..' && result.length && lastSegment != '..') {
			result.pop();
			lastSegment = result[result.length - 1];
		} else if (segment != '.') {
			result.push(lastSegment = segment);
		}
	}
	return result.join('/');
};

MobileWebModuleBuilder.prototype.parseDeps = function (deps) {
	var found = [];

	if (deps.length > 2) {
		deps = deps.replace(/\"/g, '');
		var match = deps.match(/\[(.*?)\]/);
		if (match) {
			deps = match[1];
		}
		deps = deps.split(',');
		deps.forEach(function (dep) {
			found.push(dep.trim());
		});

	}

	return found;
};

MobileWebModuleBuilder.prototype.resolveModuleId = function (mid, ref) {
	var parts = mid.split('!');
	mid = parts[parts.length-1];

	if (/^url\:/.test(mid)) {
		mid = mid.substring(4);
		if (/^\//.test(mid)) {
			mid = '.' + mid;
		}
		parts = mid.split('/');
		return [this.buildDir, mid];
	}

	if (mid.indexOf(':') != -1) return [];
	if (/^\//.test(mid) || (parts.length == 1 && /\.js$/.test(mid))) return [this.buildDir, mid];
	/^\./.test(mid) && ref && (mid = this.collapsePath(ref + mid));
	parts = mid.split('/');

	return [ this.buildDir, mid ];
};

MobileWebModuleBuilder.prototype.parseModule = function (mid, ref) {
	if (this.requireCache[mid] || mid == 'require') {
		return;
	}

	var parts = mid.split('!');

	if (parts.length == 1) {
		if (mid.charAt(0) == '.' && ref) {
			mid = this.collapsePath(ref + mid);
		}
		this.requireCache[mid] = 1;
	}

	var dep = this.resolveModuleId(mid, ref);
	if (!dep.length) {
		return;
	}

	parts.length > 1 && (this.requireCache['url:' + parts[1]] = 1);

	var srcFile = path.join(this.buildDir, mid + '.js');
	if (!fs.existsSync(srcFile)) {
		return;
	}

	var srcData = fs.readFileSync(srcFile).toString(),
		re = /define\(\s*([\'\"][^\'\"]*[\'\"]\s*)?,?\s*(\[[^\]]+\])\s*?,?\s*(function|\{)/,
		result = srcData.match(re),
		deps = this.parseDeps(result[2]);

	deps.forEach(function (dep) {
		ref = mid.split('/');
		ref.pop();
		ref = ref.join('/') + '/';
		this.parseModule(dep, ref);
	}, this);

	this.moduleMap[mid] = deps;
};

// create the builder instance and expose the public api
(function (MobileWebModuleBuilder) {
	exports.config   = MobileWebModuleBuilder.config.bind(MobileWebModuleBuilder);
	exports.validate = MobileWebModuleBuilder.validate.bind(MobileWebModuleBuilder);
	exports.run      = MobileWebModuleBuilder.run.bind(MobileWebModuleBuilder);
}(new MobileWebModuleBuilder(module)));
