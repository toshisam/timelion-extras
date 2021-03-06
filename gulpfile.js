require('babel-register')({
  presets: ['es2015']
});

var gulp = require('gulp');
var path = require('path');
var gutil = require('gulp-util');
var mkdirp = require('mkdirp');
var Rsync = require('rsync');
var Promise = require('bluebird');
var eslint = require('gulp-eslint');
var rimraf = require('rimraf');
var tar = require('gulp-tar');
var gzip = require('gulp-gzip');
var _ = require('lodash');
var aws = require('aws-sdk');
var fs = require('fs');

var pkg = require('./package.json');
var packageName = pkg.name  + '-' + pkg.version;

// relative location of Kibana install
var pathToKibana = '../kibana';

var buildDir = path.resolve(__dirname, 'build');
var targetDir = path.resolve(__dirname, 'target');
var buildTarget = path.resolve(buildDir, pkg.name);
var kibanaPluginDir = path.resolve(__dirname, pathToKibana, 'plugins', pkg.name);

var include = [
  'package.json',
  'index.js',
  'node_modules',
  'functions'
];
var exclude = Object.keys(pkg.devDependencies).map(function (name) {
  return path.join('node_modules', name);
});

function syncPluginTo(dest, done) {
  mkdirp(dest, function (err) {
    if (err) return done(err);
    Promise.all(include.map(function (name) {
      var source = path.resolve(__dirname, name);
      return new Promise(function (resolve, reject) {
        var rsync = new Rsync();
        rsync
          .source(source)
          .destination(dest)
          .flags('uav')
          .recursive(true)
          .set('delete')
          .exclude(exclude)
          .output(function (data) {
            process.stdout.write(data.toString('utf8'));
          });
        rsync.execute(function (err) {
          if (err) {
            console.log(err);
            return reject(err);
          }
          resolve();
        });
      });
    }))
    .then(function () {
      done();
    })
    .catch(done);
  });
}

gulp.task('sync', function (done) {
  syncPluginTo(kibanaPluginDir, done);
});

gulp.task('lint', function () {
  var filePaths = [
    'gulpfile.js',
    'functions/**/*.js'
  ];

  return gulp.src(filePaths)
    // eslint() attaches the lint output to the eslint property
    // of the file object so it can be used by other modules.
    .pipe(eslint())
    // eslint.format() outputs the lint results to the console.
    // Alternatively use eslint.formatEach() (see Docs).
    .pipe(eslint.formatEach())
    // To have the process exit with an error code (1) on
    // lint error, return the stream and pipe to failOnError last.
    .pipe(eslint.failOnError());
});

gulp.task('test', ['lint'], function () {
  gutil.log(gutil.colors.red('Nothing to test...'));
});

gulp.task('clean', function (done) {
  Promise.each([buildDir, targetDir], function (dir) {
    return new Promise(function (resolve, reject) {
      rimraf(dir, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
  }).nodeify(done);
});

gulp.task('build', ['clean'], function (done) {
  syncPluginTo(buildTarget, done);
});

gulp.task('package', ['build'], function () {
  return gulp.src(path.join(buildDir, '**', '*'))
    .pipe(tar(packageName + '.tar'))
    .pipe(gzip())
    .pipe(gulp.dest(targetDir));
});

gulp.task('release', ['package'], function (done) {
  var filename = packageName + '.tar.gz';

  // Upload to both elastic and kibana since there's been confusion about where the thing is.
  var keys = [
    'elastic/timelion-extras/timelion-extras-latest.tar.gz',
    'elastic/timelion-extras/' + filename
  ];

  _.each(keys, function (key) {
    var s3 = new aws.S3();
    var params = {
      Bucket: 'download.elasticsearch.org',
      Key: key,
      Body: fs.createReadStream(path.join(targetDir, filename))
    };
    s3.upload(params, function (err, data) {
      if (err) return done(err);
      gutil.log('Finished', gutil.colors.cyan('uploaded') + ' Available at ' + data.Location);
      keys.pop();
    });
  });

  function waitForUpload() {
    if (keys.length) {//we want it to match
      setTimeout(waitForUpload, 50);//wait 50 millisecnds then recheck
      return;
    }
    done();
    //real action
  }
  waitForUpload();
});

gulp.task('trickKibana', function (done) {
  const kibanaPackage = require(pathToKibana + '/package.json');
  if (pkg.version !== kibanaPackage.version) {
    const json = JSON.stringify(Object.assign({}, pkg, { version: kibanaPackage.version }, null, ' '));
    fs.writeFile(kibanaPluginDir + '/package.json', json, done);
  } else {
    done();
  }
});

gulp.task('dev', ['sync', 'trickKibana'], function () {
  gulp.watch(['package.json', 'index.js', 'functions/**/*'], ['sync', 'lint']);
});
