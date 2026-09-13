function jogWidget() {
  // new QRCode(document.getElementById("qrcode"), "http://jindo.dev.naver.com/collie");

  var jogWidgetPort = laststatus.driver.webPort || 3000; // P3: DEV build listens on a different port than 3000
  $('#jogip').html("http://" + laststatus.driver.ipaddress + ":" + jogWidgetPort + "/jog")
  $('#qrcode').empty();

  var qrcode = new QRCode("qrcode", {
    text: "http://" + laststatus.driver.ipaddress + ":" + jogWidgetPort + "/jog",
    width: 128,
    height: 128,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });

  Metro.dialog.open('#jogWidgetDialog')

}