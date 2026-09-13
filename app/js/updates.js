var time = 10
$(document).ready(function() {
  checkUpdate()
});


function checkUpdate() {
  // P4: disabled for now - this used to auto-check OpenBuilds' own GitHub
  // repo (see the getJSON URL below) and, without any real confirmation,
  // auto-download and offer to install THEIR signed installer over this
  // fork after a 10s countdown. Left in place (not deleted) so it's easy to
  // re-enable once Urban Creator CONTROL has its own release infrastructure
  // (P5) - just point the URL below at that repo and remove this return.
  return;

  if (!isMac && webgl) {

    setTimeout(function() {
      // console.log('checking for update')
      printLog("<span class='fg-darkRed'>[ update ] </span><span class='fg-darkGray'>Checking for Updates</span>")
      $.getJSON("https://api.github.com/repos/OpenBuilds/OpenBuilds-CONTROL/releases/latest", {
        crossDomain: true
      }).done(function(release) {
        if (release.name.indexOf("v") == 0) {
          var availVersion = release.name.substr(1)
        } else {
          var availVersion = release.name
        }
        //var availVersion = release.name.substr(1)
        var currentVersion = laststatus.driver.version
        // console.log(versionCompare(availVersion, currentVersion), availVersion, currentVersion);
        if (versionCompare(availVersion, currentVersion) == 1) {
          console.log('outdated')
          time = 10
          printLog("<span class='fg-darkRed'>[ Update Available! ] </span><span class='fg-green'>Urban Creator CONTROL <code>" + availVersion + "</code>. is available now.</span>")
          printLog("<span class='fg-darkRed'>[ Update Available! ] </span><span class='fg-darkGray'>Download will start in <span class='tally' id='countdown'>10</span> seconds (<a href='#' onclick='cancelTimer();'>cancel</a>) </span>")
          printLog("<span class='fg-darkRed'>[ Update Available! ] </span><span class='fg-darkGray'>You will be prompted when its ready to be installed </span>")
          setTimeout(function() {
            updateTime();
          }, 1000);
        } else {
          printLog("<span class='fg-darkRed'>[ update ] </span><span class='fg-green'>You are already running Urban Creator CONTROL " + currentVersion + "</span>")
          // setTimeout(function() {
          //   checkUpdate()
          // }, 60 * 60 * 1000) // 60 mins
          // disable regular check - once on startup is enough
        }
      });
    }, 1000)
  }
}


function updateTime() {
  time--
  if (time > 0) {
    $('#countdown').html(time)
    setTimeout(function() {
      updateTime();
    }, 1000);
  } else if (time == 0) {
    $('#countdown').html(time)
    socket.emit('downloadUpdate', true)
  }
}

function cancelTimer() {
  time = -1
  $('#countdown').html('cancelled')
  printLog("<span class='fg-darkRed'>[ Update Deferred! ] </span><span class='fg-darkGray'>No problem, we will ask you again next time</span>")
}
