function mySettings(props) {
  // Set default values if not already defined
  if (!props.settingsStorage.getItem('dbURL')) {
    props.settingsStorage.setItem('dbURL', 'https://human-centered-data-default-rtdb.firebaseio.com/');
  }

  if (!props.settingsStorage.getItem('user')) {
    props.settingsStorage.setItem('user', 'Jaewon');
  }

  if (!props.settingsStorage.getItem('fileNbr')) {
    props.settingsStorage.setItem('fileNbr', 'Ready...');
  }

  if (!props.settingsStorage.getItem('status')) {
    props.settingsStorage.setItem('status', 'Ready...');
  }

  return (
    <Page>
      <Section title={<Text bold align="center">Configuration Settings</Text>}>
        <TextInput
          settingsKey="dbURL"
          label="dbURL:"
          value={props.settingsStorage.getItem('dbURL')}
        />
        <TextInput
          settingsKey="user"
          label="user name:"
          value={props.settingsStorage.getItem('user')}
        />
      </Section>
      <Section title={<Text bold align="center">Sending file status</Text>}>
        <Text><Text bold>Last file forwarded: </Text>{props.settingsStorage.getItem('fileNbr')}</Text>
        <Text><Text bold>Status: </Text>{props.settingsStorage.getItem('status')}</Text>
      </Section>
    </Page>
  );
}

registerSettingsPage(mySettings);