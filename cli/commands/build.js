/*
 * build.js: Titanium Mobile CLI build command
 *
 * Copyright (c) 2012-2013, Appcelerator, Inc.  All Rights Reserved.
 * See the LICENSE file for more information.
 */

var appc = require('node-appc'),
	fields = require('fields'),
	fs = require('fs'),
	jsanalyze = require('titanium-sdk/lib/jsanalyze'),
	path = require('path'),
	ti = require('titanium-sdk'),
	tiappxml = require('titanium-sdk/lib/tiappxml'),
	__ = appc.i18n(__dirname).__;

fields.setup({
	formatters: {
		error: function (err) {
			if (err instanceof Error) {
				return ('[ERROR] ' + err.message).red + '\n';
			}
			err = '' + err;
			return '\n' + (/^(\[ERROR\])/i.test(err) ? err : '[ERROR] ' + err.replace(/^Error\:/i, '').trim()).red;
		}
	},
	style: {
		accelerator: 'cyan'
	}
});

exports.cliVersion = '>=3.2.1';
exports.title = __('Build');
exports.desc = __('builds a project');
exports.extendedDesc = 'Builds an existing app or module project.';

exports.config = function (logger, config, cli) {
	fields.setup({ colors: cli.argv.colors });

	return function (finished) {
		cli.createHook('build.config', function (callback) {
			ti.platformOptions(logger, config, cli, 'build', function (platformConf) {
				var conf = {
					flags: {
						'build-only': {
							abbr: 'b',
							desc: __('only perform the build; if true, does not install or run the app')
						},
						force: {
							abbr: 'f',
							desc: __('force a full rebuild')
						},
						legacy: {
							desc: __('build using the old Python-based builder.py; deprecated')
						},
						'skip-js-minify': {
							default: false,
							desc: __('bypasses JavaScript minification; %s builds are never minified; only supported for %s and %s', 'simulator'.cyan, 'Android'.cyan, 'iOS'.cyan)
						}
					},
					options: appc.util.mix({
						platform: {
							abbr: 'p',
							callback: function (platform) {
								cli.argv.$originalPlatform = platform;
								platform = ti.resolvePlatform(platform);

								var p = platformConf[platform];
								p && p.options && Object.keys(p.options).forEach(function (name) {
									if (p.options[name].default && cli.argv[name] === undefined) {
										cli.argv[name] = p.options[name].default;
									}
								});

								return platform;
							},
							desc: __('the target build platform'),
							hint: __('platform'),
							order: 2,
							prompt: {
								label: __('Target platform'),
								error: __('Invalid platform'),
								validator: function (platform) {
									if (!platform) {
										throw new Error(__('Invalid platform'));
									} else if (ti.availablePlatforms.indexOf(platform) == -1) {
										throw new Error(__('Invalid platform: %s', platform));
									}
									return true;
								}
							},
							required: true,
							skipValueCheck: true,
							values: ti.targetPlatforms
						},
						'project-dir': {
							abbr: 'd',
							callback: function (projectDir) {
								if (projectDir === '') {
									// no option value was specified
									// set project dir to current directory
									projectDir = conf.options['project-dir'].default;
								}

								// verify whether the project is an 'app' or 'module'
								// load tiapp.xml for app
								// load timodule.xml for module
								try {
									if (fs.existsSync(path.join(projectDir, 'tiapp.xml'))) {
										var tiapp = cli.tiapp = new tiappxml(path.join(projectDir, 'tiapp.xml'));

										tiapp.properties || (tiapp.properties = {});

										// make sure the tiapp.xml is sane
										ti.validateTiappXml(logger, config, tiapp);

										// check that the Titanium SDK version is correct
										if (!ti.validateCorrectSDK(logger, config, cli, 'build')) {
											throw new cli.GracefulShutdown();
										}

										cli.argv.type = 'app';
										dump("FOUND tiapp.xml");

									} else if (fs.existsSync(path.join(projectDir, 'timodule.xml'))) {
										// QUESTION: instead of using tiappxml,
										// should we parse 'timodule.xml' differently?
										// build.py doesn't use timodule.xml
										var timodule = cli.timodule = new tiappxml(path.join(projectDir, 'timodule.xml'));
										timodule.properties || (timodule.properties = {});

										cli.argv.type = 'module';
										dump("FOUND timodule.xml");

									} else {
										dump("FOUND nothing");
										// neither app nor module
										return;
									}
								} catch (ex) {
									logger.error(ex);
									logger.log();
									process.exit(1);
								}

								return projectDir;
							},
							desc: __('the directory containing the project'),
							default: process.env.SOURCE_ROOT ? path.join(process.env.SOURCE_ROOT, '..', '..') : '.',
							order: 1,
							prompt: function (callback) {
								callback(fields.file({
									promptLabel: __('Where is the __project directory__?'),
									complete: true,
									showHidden: true,
									ignoreDirs: new RegExp(config.get('cli.ignoreDirs')),
									ignoreFiles: /.*/,
									validate: conf.options['project-dir'].validate
								}));
							},
							required: true,
							validate: function (projectDir, callback) {
								dump("VALIDATE");
								var isDefault = projectDir == conf.options['project-dir'].default;

								var dir = appc.fs.resolvePath(projectDir);

								if (!fs.existsSync(dir)) {
									return callback(new Error(__('Project directory does not exist')));
								}

								var isFound,
									root = path.resolve('/');

								['tiapp.xml', 'timodule.xml'].some(function (tiXml) {
									dump(">>" + tiXml);
									dir = appc.fs.resolvePath(projectDir);
									var tiFile = path.join(dir, tiXml);
									dump(">"+tiFile);

									while (!fs.existsSync(tiFile)) {
										dir = path.dirname(dir);
										if (dir == root) {
											isFound = false;
											break;
										}
										tiFile = path.join(dir, tiXml);
										dump("--> " + tiFile);
									}

									// Found the xml file, break the loop
									if (fs.existsSync(tiFile)) {
										isFound = true;
										return true;
									}
									dump(">>> " + dir);
								});

								if (!isFound && dir == root && isDefault) {
									callback(true);
									return;
								}

								if (!isFound) {
									callback(new Error(__('Invalid project directory "%s" because tiapp.xml or timodule.xml not found', projectDir)));
									return;
								}

								callback(null, dir);
							}
						}
					}, ti.commonOptions(logger, config)),
					platforms: platformConf
				};
				callback(null, conf);
			});
		})(function (err, result) {
			finished(result);
		});
	};
};

exports.validate = function (logger, config, cli) {
	// TODO: set the type to 'app' for now, but we'll need to determine if the project is an app or a module
	//cli.argv.type = 'app';

	if (cli.argv.type === 'module') {
		logger.info("------ module validate");

		return function (finished) {
			var result = ti.validatePlatformOptions(logger, config, cli, 'buildModule');
			if (result && typeof result == 'function') {
				result();
			}
			finished(result);
		};

	} else {
		logger.info("------ app validate");

		ti.validatePlatform(logger, cli, 'platform');

		// since we need validate() to be async, we return a function in which the cli
		// will immediately call
		return function (finished) {
			function next(result) {
				if (result !== false) {
					// no error, load the tiapp.xml plugins
					ti.loadPlugins(logger, config, cli, cli.argv['project-dir'], function () {
						finished(result);
					});
				} else {
					finished(result);
				}
			}

			// loads the platform specific bulid command and runs its validate() function
			var result = ti.validatePlatformOptions(logger, config, cli, 'build');
			if (result && typeof result == 'function') {
				result(next);
			} else {
				next(result);
			}
		};
	}
};

exports.run = function (logger, config, cli, finished) {
	logger.info("----->>> run");
	logger.info("----->>> cli.argv.type: " + cli.argv.type);

	var buildFile = (cli.argv.type === 'module') ? '_buildModule.js' :'_build.js',
		platform = ti.resolvePlatform(cli.argv.platform),
		buildModule = path.join(__dirname, '..', '..', platform, 'cli', 'commands', buildFile),
		counter = 0;

	if (!fs.existsSync(buildModule)) {
		logger.error(__('Unable to find platform specific build command') + '\n');
		logger.log(__("Your SDK installation may be corrupt. You can reinstall it by running '%s'.", (cli.argv.$ + ' sdk update --force --default').cyan) + '\n');
		process.exit(1);
	}

	if (config.get('cli.sendAPIUsage', true)) {
		cli.on('build.finalize', function (builder) {
			var deployType = builder.deployType || cli.argv['deploy-type'] || null;
			if (deployType == 'production') {
				cli.addAnalyticsEvent('Titanium API Usage', {
					platform: platform,
					tisdkname: (ti.manifest && ti.manifest.name) || (cli.sdk && cli.sdk.name) || null,
					tisdkver: (ti.manifest && ti.manifest.version) || (cli.sdk && cli.sdk.name) || null,
					deployType: deployType,
					target: builder.target || cli.argv.target || null,
					usage: jsanalyze.getAPIUsage()
				}, 'ti.apiusage');
			}
		});
	}

	require(buildModule).run(logger, config, cli, function (err) {
		if (!counter++) {
			var delta = appc.time.prettyDiff(cli.startTime, Date.now());
			if (err) {
				logger.error(__('Project failed to build after %s', delta) + '\n');
				process.exit(1);
			} else {
				logger.info(__('Project built successfully in %s', delta.cyan) + '\n');
			}

			finished();
		}
	});
};
