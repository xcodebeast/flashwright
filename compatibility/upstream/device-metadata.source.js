function calculateUserAgentMetadata(options2) {
  const ua = options2.userAgent;
  if (!ua)
    return void 0;
  const metadata = {
    mobile: !!options2.isMobile,
    model: "",
    architecture: "x86",
    platform: "Windows",
    platformVersion: ""
  };
  const androidMatch = ua.match(/Android (\d+(\.\d+)?(\.\d+)?)/);
  const iPhoneMatch = ua.match(/iPhone OS (\d+(_\d+)?)/);
  const iPadMatch = ua.match(/iPad; CPU OS (\d+(_\d+)?)/);
  const macOSMatch = ua.match(/Mac OS X (\d+(_\d+)?(_\d+)?)/);
  const windowsMatch = ua.match(/Windows\D+(\d+(\.\d+)?(\.\d+)?)/);
  if (androidMatch) {
    metadata.platform = "Android";
    metadata.platformVersion = androidMatch[1];
    metadata.architecture = "arm";
  } else if (iPhoneMatch) {
    metadata.platform = "iOS";
    metadata.platformVersion = iPhoneMatch[1];
    metadata.architecture = "arm";
  } else if (iPadMatch) {
    metadata.platform = "iOS";
    metadata.platformVersion = iPadMatch[1];
    metadata.architecture = "arm";
  } else if (macOSMatch) {
    metadata.platform = "macOS";
    metadata.platformVersion = macOSMatch[1];
    if (!ua.includes("Intel"))
      metadata.architecture = "arm";
  } else if (windowsMatch) {
    metadata.platform = "Windows";
    metadata.platformVersion = windowsMatch[1];
  } else if (ua.toLowerCase().includes("linux")) {
    metadata.platform = "Linux";
  }
  if (ua.includes("ARM"))
    metadata.architecture = "arm";
  return metadata;
}
