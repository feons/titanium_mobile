/**
* iOS build command.
*
* @module cli/_buildModule
*
* @copyright
* Copyright (c) 2009-2014 by Appcelerator, Inc. All Rights Reserved.
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
	ioslib = require('ioslib'),
	iosPackageJson = appc.pkginfo.package(module),
	fs = require('fs'),
	path = require('path'),
	readline = require('readline'),
	stream = require('stream');
	spawn = require('child_process').spawn,
	ti = require('titanium-sdk'),
	util = require('util'),
	wrench = require('wrench'),
	__ = appc.i18n(__dirname).__,
	afs = appc.fs,
	parallel = appc.async.parallel,
	series = appc.async.series,
	version = appc.version;

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

function iOSModuleBuilder() {
	Builder.apply(this, arguments);
}

util.inherits(iOSModuleBuilder, Builder);

iOSModuleBuilder.prototype.config = function (logger, config, cli) {
	Builder.prototype.config.apply(this, arguments);
	console.log("--- iOSModuleBuilder config");
};

iOSModuleBuilder.prototype.validate = function (logger, config, cli) {
	console.log("--- iOSModuleBuilder validate");

	this.xcodeEnv = null;

	return function(finished) {
		logger.info("return validate");

		ioslib.detect({
			// env
			xcodeSelect: config.get('osx.executables.xcodeSelect'),
			security: config.get('osx.executables.security'),
			// provisioning
			profileDir: config.get('ios.profileDir'),
			// xcode
			searchPath: config.get('paths.xcode'),
			minIosVersion: iosPackageJson.minIosVersion,
			supportedVersions: iosPackageJson.vendorDependencies.xcode
		}, function (err, iosInfo) {
			this.iosInfo = iosInfo;

			// Question: do we need to check cli.argv['ios-version']?
			Object.keys(this.iosInfo.xcode).forEach(function (ver) {
				if (ver != '__selected__' && (!this.xcodeEnv || this.iosInfo.xcode[ver].selected)) {
						this.xcodeEnv = this.iosInfo.xcode[ver];
				}
			}, this);

			if (!this.xcodeEnv) {
				// this should never happen
				logger.error(__('Unable to find suitable Xcode install that supports iOS SDK %s', cli.argv['ios-version']) + '\n');
				process.exit(1);
			}
		}.bind(this));
	}.bind(this);
};

iOSModuleBuilder.prototype.run = function (logger, config, cli, finished) {
	Builder.prototype.run.apply(this, arguments);

	console.log("--- iOSModuleBuilder run");

	this.cli = cli;
	this.logger = logger;

	series(this, [
		'initialize',

		'processManifest',
		'validateLicense',
		//'validateTiXcconfig',
		//'compileJS', <--- figure this out
		'buildModule',
		'createUniBinary',
		//'genereateDoc',
		//'packageModule',
	], function () {
		finished();
	});
};

iOSModuleBuilder.prototype.initialize = function (next) {
	console.log("-- iOSBuilder.prototype.initialize");
	next();
};

iOSModuleBuilder.prototype.processManifest = function (next) {
	console.log("-- iOSBuilder.prototype.processManifest");

	// Should we put this in a seperate place?
	// Since it'll be used by module build for other platforms too

	var manifestFile = path.join(this.projectDir, 'manifest');

	if (!fs.existsSync(manifestFile)) {
		this.logger.error(__('Missing %s', manifestFile));
		this.logger.log();
		process.exit(1);
	}

	var	re = /^(\S+)\s*:\s*(.*)$/,
		match,
		instream = fs.createReadStream(manifestFile),
		readLine = readline.createInterface(instream, new stream),
		manifestObj = {},
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

	readLine.on('line', function(line) {
		match = line.match(re);
		if (match) {
			manifestObj[match[1].trim()] = match[2].trim();
		}
	});

	readLine.on('close', function() {
		// check if all the required module keys are in the list
		requiredModuleKeys.forEach(function (key) {
			if (!manifestObj.hasOwnProperty(key)) {
				this.logger.error(__('Missing required manifest key "%s"', key));
				this.logger.log();
				process.exit(1);
			}
		}.bind(this));

		this.manifest = manifestObj;
		next();
	}.bind(this));
};

iOSModuleBuilder.prototype.validateLicense = function (next) {
	console.log("-- iOSBuilder.prototype.validateLicense");
	next();
};

iOSModuleBuilder.prototype.validateTiXcconfig = function (next) {
	console.log("-- iOSBuilder.prototype.validateTiXcconfig");
	next();
};

iOSModuleBuilder.prototype.compileJS = function (next) {
	console.log("-- iOSBuilder.prototype.compileJS");

	// [Module ID].js, this is an optional file
	// eg. com.example.test.js
	var moduleJS =  this.manifest.moduleid + '.js',
		jsFile = path.join(this.projectDir, 'assets', moduleJS );
	if (!fs.existsSync(manifestFile)) {
		jsFile = path.join(this.projectDir, '..', 'assets', moduleJS );
	}

	if (!fs.existsSync(manifestFile)) {
		next();
	}

	console.log(" found " + moduleJS +" in " + jsFile);
	next();
};

iOSModuleBuilder.prototype.buildModule = function (next) {
	console.log("-- iOSBuilder.prototype.buildModule");

	var xcodebuildHook = this.cli.createHook('build.ios.xcodebuild', this, function (exe, args, opts, done) {
			var p = spawn(exe, args, opts),
				out = [],
				err = [],
				stopOutputting = false;

			p.stdout.on('data', function (data) {
				data.toString().split('\n').forEach(function (line) {
					if (line.length) {
						out.push(line);
						if (line.indexOf('Failed to minify') != -1) {
							stopOutputting = true;
						}
						if (!stopOutputting) {
							this.logger.trace(line);
						}
					}
				}, this);
			}.bind(this));

			p.stderr.on('data', function (data) {
				data.toString().split('\n').forEach(function (line) {
					if (line.length) {
						err.push(line);
					}
				}, this);
			}.bind(this));

			p.on('close', function (code, signal) {
				if (code) {
					// just print the entire error buffer
					err.forEach(function (line) {
						this.logger.error(line);
					}, this);
					this.logger.log();
					process.exit(1);
				}

				// end of the line
				done(code);
			}.bind(this));

		});

	// Create a build for the device
	xcodebuildHook(
		this.xcodeEnv.executables.xcodebuild,
		[
			'-configuration', 'Release',
			'-sdk', 'iphoneos'
		],
		{
			cwd: this.projectDir,
			env: {
				DEVELOPER_DIR: this.xcodeEnv.path,
				TMPDIR: process.env.TMPDIR,
				HOME: process.env.HOME,
				PATH: process.env.PATH,
				TITANIUM_CLI_XCODEBUILD: 'Enjoy hacking? http://jobs.appcelerator.com/',
				TITANIUM_CLI_IMAGES_OPTIMIZED: this.target == 'simulator' ? '' : this.imagesOptimizedFile
			}
		},
		null
	);

	// Create a build for the simulator
	xcodebuildHook(
		this.xcodeEnv.executables.xcodebuild,

		[
			'-configuration', 'Release',
			'-sdk', 'iphonesimulator'
		],
		{
			cwd: this.projectDir,
			env: {
				DEVELOPER_DIR: this.xcodeEnv.path,
				TMPDIR: process.env.TMPDIR,
				HOME: process.env.HOME,
				PATH: process.env.PATH,
				TITANIUM_CLI_XCODEBUILD: 'Enjoy hacking? http://jobs.appcelerator.com/',
				TITANIUM_CLI_IMAGES_OPTIMIZED: this.target == 'simulator' ? '' : this.imagesOptimizedFile
			}
		},
		next
	);
};

iOSModuleBuilder.prototype.createUniBinary = function (next) {
	console.log("-- iOSBuilder.prototype.createUniBinary");

	// Create a universal build by merging the all builds to a single binary
	var binaryFiles = [],
		outputFile = path.join(this.projectDir, 'build', 'lib'+this.manifest['moduleid']+'.a'),
		lipoArgs = ['-create',
					'-output',
					outputFile
		];

	var traverseDirectory = function (currentPath) {
		var files = fs.readdirSync(currentPath);
		for (var i in files) {
			var currentFile = path.join(currentPath, files[i]);
			var stats = fs.statSync(currentFile);

			if (stats.isFile() &&
				path.extname(currentFile) === '.a' &&
				currentFile.indexOf('test.build') === -1 &&
				currentFile.indexOf('Release-') > -1) {
					binaryFiles.push(currentFile);
			} else if (stats.isDirectory()) {
				traverseDirectory(currentFile);
			}
		}
	};

	traverseDirectory(path.join(this.projectDir, 'build'));
	appc.subprocess.run('lipo', binaryFiles.concat(lipoArgs), function (code, out, err) {
		next();
	});
};


iOSModuleBuilder.prototype.genereateDoc = function (next) {
	console.log("-- iOSBuilder.prototype.genereateDoc");

	var documentDir = path.join(this.projectDir, 'documentation'),
		documentation = [];

	if (!fs.existsSync(documentDir)) {
		documentDir = path.join(this.projectDir, '..', 'documentation');
	}

	if (fs.existsSync(documentDir)) {
		var markdown = require( "markdown" ).markdown;
		var files = fs.readdirSync(documentDir);
		for (var i in files) {
			var file = files[i],
				currentFile = path.join(documentDir, file);
			if (fs.statSync(currentFile).isFile()) {
				var obj = {},
					contents = fs.readFileSync(currentFile).toString();

				obj[file] = markdown.toHTML(contents);
				documentation.push(obj);
			}
		}
	}

	this.documentation = documentation;
	next();
};


iOSModuleBuilder.prototype.packageModule = function (next) {
	console.log("-- iOSBuilder.prototype.packageModule");

	var dest = archiver('zip', {
			forceUTC: true
		}),
		zipStream,
		origConsoleError = console.error,
		name = this.manifest.name,
		moduleId = this.manifest.moduleid,
		version = this.manifest.version,
		moduleZipName = [moduleId, '-iphone-', version, '.zip'].join(''),
		moduleZipFullPath = path.join(this.projectDir, moduleZipName);

	var moduleFolders = path.join("modules", "iphone", moduleId, version);
		manifestFile = path.join(this.projectDir, "manifest"),
		binarylibFile = path.join(this.projectDir, "build", "lib"+moduleId+".a"),
		xcconfigFile = path.join(this.projectDir, "module.xcconfig");

	//console.log("moduleZipName : " + moduleZipName);
	//console.log("moduleFolders : " + moduleFolders);
	//console.log("manifestFile : " + manifestFile);
	//console.log("binarylibFile : " + binarylibFile);
	//console.log("xcconfigFile : " + xcconfigFile);


	// since the archiver library didn't set max listeners, we squelch all error output
	console.error = function () {};

	try {
		// if the zip file is there, remove it
		fs.existsSync(moduleZipFullPath) && fs.unlinkSync(moduleZipFullPath);
		zipStream = fs.createWriteStream(moduleZipFullPath);
		zipStream.on('close', function() {
			console.error = origConsoleError;
			next();
		});
		dest.catchEarlyExitAttached = true; // silence exceptions
		dest.pipe(zipStream);

		this.logger.info(__('Creating module zip'));

		// 1. documentation folder
		// 2. example folder
		// 3. the merge *.a file
		dest.append(fs.createReadStream(binarylibFile), { name: "lib"+moduleId+".a" });
		// 4. LICENSE file
		// 5. manifest
		dest.append(fs.createReadStream(manifestFile), { name: 'manifest' });
		// 6. module.xcconfig
		dest.append(fs.createReadStream(xcconfigFile), { name: 'module.xcconfig' });

		this.logger.info(__('Writing module zip: %s', moduleZipFullPath));
		dest.finalize();
	} catch (ex) {
		console.error = origConsoleError;
		throw ex;
	}

	next();
};

// create the builder instance and expose the public api
(function (iOSModuleBuilder) {
	exports.config   = iOSModuleBuilder.config.bind(iOSModuleBuilder);
	exports.validate = iOSModuleBuilder.validate.bind(iOSModuleBuilder);
	exports.run      = iOSModuleBuilder.run.bind(iOSModuleBuilder);
}(new iOSModuleBuilder(module)));
